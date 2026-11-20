/**
 * Compakta - local media optimization server.
 *
 * Bun.serve() on localhost only. Every route either reads state or shells out
 * to the local ImageMagick build. The source tree is never written to.
 */
import { existsSync, readdirSync } from "node:fs";
import { readdir, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { scanLibrary, type ScanResult, type ScannedFile } from "./scan.ts";
import {
  applyPolicy, normalisePolicy, DEFAULT_POLICY, outputPathFor,
  type Policy, type Preview,
} from "./policy.ts";
import {
  FORMAT_SPECS, OUTPUT_FORMATS, buildEncoderArgs,
  isOutputFormat, qualityDisplay, sourceArgFor, type OutputFormat,
} from "./formats.ts";
import {
  findMagick, assertDestinationSafe, freeSpace, ensureDir, dirExists, type MagickInfo,
} from "./paths.ts";
import { estimateFromSample, type Estimate } from "./estimate.ts";
import { findDuplicates, type DedupeResult } from "./dedupe.ts";
import { identifyMany, buildDateReport, type DateReport, type ImageFacts } from "./meta.ts";
import { verifyOutputs, type VerifyReport } from "./verify.ts";
import { planBudget, type BudgetPlan } from "./budget.ts";
import { runHealthCheck, type HealthReport } from "./health.ts";
import { Job, getJob, liveJob, pausedJob, newJob, manifestsFor, undoManifest } from "./jobs.ts";
import { analyseSync, cleanOrphans, pendingOnly, type SyncReport } from "./sync.ts";
import { formatBytes, runPool } from "./convert.ts";
import { checkForUpdate, installLatest, installProgress, isInstallInProgress } from "./imagemagick.ts";
import {
  applyAppUpdate,
  checkAppUpdate,
  dismissAppUpdate,
  downloadAppUpdate,
  getAppUpdateProgress,
  setApplyBusyGuard,
} from "./app-update.ts";
import { CASE_INSENSITIVE, IS_LINUX, IS_WINDOWS, pathKey, REL_SEP } from "./platform.ts";
import { PREVIEW_CACHE_DIR, PUBLIC_DIR } from "./appdirs.ts";
import { loadPersistedSettings, savePersistedSettings, recordRecentSource } from "./settings.ts";
import {
  currentVideoPreview,
  handleVideoApi,
  isVideoJobActive,
  isVideoRunStarting,
  resetVideoScanState,
  type SharedServerBridge,
} from "./video/routes.ts";
import { findFfmpeg } from "./video/ffmpeg.ts";
import { extractVideoFramePng } from "./video/meta.ts";

// Resolved by startServer(). A source run keeps the project layout; the
// desktop entrypoint passes the packaged resources and the writable cache.
let publicDir = PUBLIC_DIR;
let previewCacheDir = PREVIEW_CACHE_DIR;

// --------------------------------------------------------------------------
// Shared server state
// --------------------------------------------------------------------------

type State = {
  sourceRoot: string;
  destination: string;
  magick: MagickInfo | null;
  scan: ScanResult | null;
  /** rel -> file, so the compare and passthrough routes are O(1) not O(11k). */
  index: Map<string, ScannedFile>;
  policy: Policy;
  /** Flat fallback ratio per output format, replaced by a real Estimate. */
  ratios: Record<OutputFormat, number>;
  budgetBytes: number;
  lastPreview: Preview | null;
  lastEstimate: Estimate | null;
  dedupe: DedupeResult | null;
  verify: VerifyReport | null;
  dates: DateReport | null;
  sync: SyncReport | null;
  /** Where the originals also live, for the redundancy banner. */
  redundantRoots: string[];
};

function defaultSourceRoot(): string {
  const configured =
    process.env.COMPAKTA_SOURCE?.trim() ||
    process.env.PICMAGIK_SOURCE?.trim();
  if (configured) return path.resolve(configured);
  const saved = loadPersistedSettings();
  if (saved.sourceRoot && existsSync(saved.sourceRoot)) {
    return path.resolve(saved.sourceRoot);
  }
  const pictures = path.join(homedir(), "Pictures");
  return existsSync(pictures) ? pictures : homedir();
}

const savedSettings = loadPersistedSettings();

const DEFAULT_SOURCE = defaultSourceRoot();
const DEFAULT_DESTINATION =
  process.env.COMPAKTA_DESTINATION?.trim() ||
  process.env.PICMAGIK_DESTINATION?.trim() ||
  savedSettings.destination ||
  `${DEFAULT_SOURCE}-avif`;

function defaultRatios(): Record<OutputFormat, number> {
  return Object.fromEntries(
    OUTPUT_FORMATS.map((id) => [id, FORMAT_SPECS[id].defaultRatio]),
  ) as Record<OutputFormat, number>;
}

const state: State = {
  sourceRoot: DEFAULT_SOURCE,
  destination: DEFAULT_DESTINATION,
  magick: null,
  scan: null,
  index: new Map(),
  policy: normalisePolicy(savedSettings.policy ?? DEFAULT_POLICY),
  ratios: defaultRatios(),
  budgetBytes: savedSettings.budgetBytes ?? 10 * 1024 ** 3,
  lastPreview: null,
  lastEstimate: null,
  dedupe: null,
  verify: null,
  dates: null,
  sync: null,
  redundantRoots: [],
};

const videoBridge: SharedServerBridge = {
  getSourceRoot: () => state.sourceRoot,
  getPhotoDestination: () => state.destination,
  getPhotoPolicy: () => state.policy,
  getBudgetBytes: () => state.budgetBytes,
  setBudgetBytes: (b: number) => { state.budgetBytes = b; },
  getScan: () => state.scan,
  getFileByRel: (rel: string) => findFileByRel(rel),
  getPreviewCacheDir: () => previewCacheDir,
};

function requireMagick(): MagickInfo {
  if (!state.magick) {
    try {
      state.magick = findMagick();
    } catch (err) {
      throw new HttpError(400, singleLine((err as Error).message));
    }
  }
  return state.magick;
}

const currentRatio = () => state.ratios[state.policy.outputFormat];

export function openPathInOs(targetPath: string): boolean {
  try {
    if (process.platform === "win32") {
      spawn("explorer.exe", [targetPath], { detached: true, stdio: "ignore" }).unref();
      return true;
    } else if (process.platform === "darwin") {
      spawn("open", [targetPath], { detached: true, stdio: "ignore" }).unref();
      return true;
    } else {
      spawn("xdg-open", [targetPath], { detached: true, stdio: "ignore" }).unref();
      return true;
    }
  } catch {
    return false;
  }
}

/**
 * Merge a policy update without losing the per-format slider values.
 *
 * When the format changes and the caller did not send a quality or speed,
 * apply that format's defaults rather than reusing AVIF's. The UI always
 * sends both values, so this mainly protects direct API callers.
 */
function mergePolicyUpdate(current: Policy, incoming: Partial<Policy> | undefined): Policy {
  const merged = { ...current, ...(incoming ?? {}) };
  const nextFormat = isOutputFormat(merged.outputFormat)
    ? merged.outputFormat
    : current.outputFormat;
  const formatChanged = nextFormat !== current.outputFormat;
  const spec = FORMAT_SPECS[nextFormat];

  return normalisePolicy({
    ...merged,
    outputFormat: nextFormat,
    qualities: incoming?.qualities
      ?? (formatChanged ? [spec.quality.default] : current.qualities),
    heicSpeed: incoming?.heicSpeed
      ?? (formatChanged ? spec.speed.default : current.heicSpeed),
  });
}

/** Apply a policy update and drop reports that described the old format. */
function applyPolicyUpdate(incoming: Partial<Policy> | undefined): void {
  if (!incoming) return;
  const previous = state.policy.outputFormat;
  state.policy = mergePolicyUpdate(state.policy, incoming);
  if (state.policy.outputFormat !== previous) {
    state.lastEstimate = null;
    state.sync = null;
  }
}

function currentPreview(): Preview {
  if (!state.scan) throw new HttpError(400, "Scan the library first.");
  state.lastPreview = applyPolicy(state.scan, state.policy, currentRatio());
  return state.lastPreview;
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, jsonReplacer), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

/**
 * INSV-2/FS-01: every request body is JSON, size-capped, and non-negotiable.
 * A missing or lying content-length only delays the verdict: the streamed
 * bytes are counted too, and an oversized stream is cut off before it can
 * fill the heap. Wrong content-type is 415; oversized is 413; junk JSON is 400.
 */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export async function readBody<T>(req: Request): Promise<T> {
  const ct = req.headers.get("content-type") ?? "";
  if (ct && !/^application\/([a-z0-9.+-]+\+)?json\b/i.test(ct)) {
    throw new HttpError(415, "Content-Type must be application/json.");
  }
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new HttpError(413, `Body too large (max ${formatBytes(MAX_BODY_BYTES)}).`);
  }
  const reader = req.body?.getReader();
  if (!reader) throw new HttpError(400, "Malformed JSON body.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      try { await reader.cancel(); } catch { /* already closing */ }
      throw new HttpError(413, `Body too large (max ${formatBytes(MAX_BODY_BYTES)}).`);
    }
    chunks.push(value);
  }
  const raw = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { raw.set(chunk, at); at += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(raw)) as T; }
  catch { throw new HttpError(400, "Malformed JSON body."); }
}

/** INSV-1/FS-04: stderr lines must stay single-line (NTFS allows \r\n in paths). */
export function singleLine(s: unknown): string {
  return String(s).replace(/[\r\n]+/g, " | ");
}

/**
 * INSV-1/FS-04: destination validations are user-input errors. Wrapping the
 * assert keeps them HTTP 400 (with the caller-supplied paths echoed back to
 * the caller who supplied them) instead of a 500 that leaks internal roots.
 */
export function safeDestination(source: string, destination: string): void {
  try { assertDestinationSafe(source, destination); }
  catch (err) { throw new HttpError(400, singleLine((err as Error).message)); }
}

/**
 * INSV-3: `Number()` coercion with a fallback for junk — JSON cannot carry
 * NaN, but it can carry `"abc"`, strings, nulls; pool sizing must never go
 * NaN into a spawn loop.
 */
export function clampInt(v: unknown, dflt: number, min: number, max: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
}

/**
 * FS-05: heavy walks (full library scans, sample encodes, hashing sweeps,
 * ffprobe batches) run one at a time per kind, or two overlapping requests
 * thrash the disk and the last-completed one silently wins a race the user
 * never asked for. Released in `finally` so a failed walk cannot wedge the
 * next one.
 */
const busy: Set<string> = new Set();
export async function withBusy<T>(kind: string, message: string, fn: () => Promise<T>): Promise<T> {
  if (busy.has(kind)) throw new HttpError(409, message);
  busy.add(kind);
  try { return await fn(); }
  finally { busy.delete(kind); }
}

/** Full-precision floats are noise in a JSON payload and bloat SSE frames. */
function jsonReplacer(_k: string, v: unknown) {
  if (typeof v === "number" && !Number.isInteger(v)) return Number(v.toFixed(4));
  return v;
}

const bytes = (n: unknown) => typeof n === "number" ? formatBytes(n) : "";

/** Extensions the compare view can actually display. */
const IMAGE_MIME: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", jpe: "image/jpeg", jfif: "image/jpeg",
  heic: "image/heic", heif: "image/heif",
  png: "image/png", gif: "image/gif", bmp: "image/bmp", webp: "image/webp",
  tif: "image/tiff", tiff: "image/tiff", avif: "image/avif",
};

/** Ceiling for the in-browser original preview. */
const MAX_PASSTHROUGH_BYTES = 64 * 1024 * 1024;

const NATIVE_IMAGE_EXTS = new Set([
  "jpg", "jpeg", "jpe", "jfif", "png", "gif", "bmp", "webp", "avif",
]);

function cacheKeyFor(file: ScannedFile, prefix: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(`${file.abs}:${file.mtime}:${file.size}`);
  return `${prefix}_${hasher.digest("hex").slice(0, 16)}.jpg`;
}

/**
 * Limits concurrent thumbnail/preview child processes so scrolling a huge
 * folder never storms the CPU with dozens of ImageMagick instances.
 */
function createSemaphore(max: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const release = () => {
    active--;
    const next = queue.shift();
    if (next) next();
  };
  const acquire = (signal?: AbortSignal): Promise<() => void> => {
    if (signal?.aborted) return Promise.reject(new HttpError(499, "Client closed request"));
    if (active < max) {
      active++;
      return Promise.resolve(release);
    }
    return new Promise((resolve, reject) => {
      const task = () => {
        signal?.removeEventListener("abort", onAbort);
        active++;
        resolve(release);
      };
      const onAbort = () => {
        const idx = queue.indexOf(task);
        if (idx >= 0) queue.splice(idx, 1);
        reject(new HttpError(499, "Client closed request"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      queue.push(task);
    });
  };
  return { acquire };
}

const previewSemaphore = createSemaphore(4);

/**
 * Run ImageMagick to a temporary sibling file and atomically rename on success.
 * Kills the full Linux process group on abort/timeout so AppImage inner
 * processes cannot leak or leave 0-byte/truncated files in the preview cache.
 */
async function runMagickAtomic(
  magickPath: string,
  partPath: string,
  destPath: string,
  buildArgs: (target: string) => string[],
  signal?: AbortSignal,
  timeoutMs = 30_000,
): Promise<number> {
  await rm(partPath, { force: true }).catch(() => {});
  try {
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new HttpError(499, "Cancelled"));
        return;
      }
      const child = spawn(magickPath, buildArgs(partPath), {
        windowsHide: true,
        detached: process.platform === "linux",
        stdio: "ignore",
        env: { ...process.env, MAGICK_THREAD_LIMIT: "1" },
      });
      const killTree = () => {
        if (process.platform === "linux" && child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
            return;
          } catch { /* not a group leader */ }
        }
        try { child.kill(); } catch { /* already gone */ }
      };
      const onAbort = () => {
        clearTimeout(timer);
        killTree();
        reject(new HttpError(499, "Cancelled"));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        killTree();
        reject(new Error("ImageMagick decode timed out"));
      }, timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      child.on("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (code === 0) resolve();
        else reject(new Error(`ImageMagick exited with code ${code ?? -1}`));
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(err);
      });
    });
    const st = await stat(partPath);
    if (st.size === 0) throw new Error("encoder wrote nothing");
    await rename(partPath, destPath);
    return st.size;
  } finally {
    await rm(partPath, { force: true }).catch(() => {});
  }
}

/**
 * Keep the disposable preview cache bounded across sessions:
 *   - compare encodes (`cmp-*`, `vcmp-*`) older than 1 hour are deleted
 *   - every cached preview older than 14 days is deleted
 *   - if the cache still exceeds 500 MB, evict the oldest files to 400 MB
 *
 * Runs in the background at startup; failures are never user-visible because
 * the cache can always be regenerated.
 */
async function prunePreviewCache(cacheDir: string): Promise<void> {
  if (!existsSync(cacheDir)) return;
  const now = Date.now();
  const ONE_HOUR_MS = 60 * 60 * 1000;
  const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;
  const MAX_CACHE_BYTES = 500 * 1024 * 1024;
  const TARGET_CACHE_BYTES = 400 * 1024 * 1024;

  try {
    const entries = await readdir(cacheDir, { withFileTypes: true });
    const survivors: { full: string; size: number; mtimeMs: number }[] = [];
    let totalBytes = 0;

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const full = path.join(cacheDir, entry.name);
      try {
        const st = await stat(full);
        const ageMs = now - st.mtimeMs;
        const isCompareTemp =
          entry.name.startsWith("cmp-") || entry.name.startsWith("vcmp-");

        if ((isCompareTemp && ageMs > ONE_HOUR_MS) || ageMs > FOURTEEN_DAYS_MS) {
          await rm(full, { force: true });
          continue;
        }
        survivors.push({ full, size: st.size, mtimeMs: st.mtimeMs });
        totalBytes += st.size;
      } catch {
        /* ignore file race */
      }
    }

    if (totalBytes > MAX_CACHE_BYTES) {
      survivors.sort((a, b) => a.mtimeMs - b.mtimeMs);
      for (const item of survivors) {
        if (totalBytes <= TARGET_CACHE_BYTES) break;
        await rm(item.full, { force: true }).catch(() => {});
        totalBytes -= item.size;
      }
    }
  } catch {
    /* ignore background cache cleanup errors */
  }
}

function findFileByRel(rel: string | null): ScannedFile | undefined {
  if (!rel) return undefined;
  const direct = state.index.get(rel);
  if (direct) return direct;
  const backslash = rel.replace(/\//g, "\\");
  const forward = rel.replace(/\\/g, "/");
  const bySlash = state.index.get(backslash) ?? state.index.get(forward);
  if (bySlash) return bySlash;
  const needle = rel.replace(/[\\/]+/g, "/").toLowerCase();
  for (const [key, file] of state.index.entries()) {
    if (key.replace(/[\\/]+/g, "/").toLowerCase() === needle) {
      return file;
    }
  }
  return undefined;
}

/** Set after Bun.serve() so the shutdown route can stop the listener. */
let requestShutdown: (() => void) | null = null;

/** True while POST /api/run sits between its live-check and job.start(). */
let runStarting = false;

/**
 * MED-1: exported so the self-updater busy guard and the shutdown grace poll
 * can see the in-flight run-start lock. A run accepted just before apply/settle
 * sets this flag with no job in `running` state yet during awaited pre-flight
 * (ensureDir/analyseSync), so it is the only signal those guards have.
 */
export function isRunStarting(): boolean {
  return runStarting;
}

// --------------------------------------------------------------------------
// Routes
// --------------------------------------------------------------------------

async function handleApi(pathname: string, req: Request, url: URL): Promise<Response> {
  const route = pathname.replace(/^\/api\/?/, "");

  if (route === "video" || route.startsWith("video/")) {
    try {
      return await handleVideoApi(route.slice("video".length).replace(/^\/+/, ""), req, url, videoBridge);
    } catch (err) {
      // INSV-4: status-carrying errors are route-intended (validation, 409s);
      // keep their message, flattened. Anything else is internal — log the
      // stack single-line to stderr and answer shapeless so library/spawn
      // messages (ENOENT paths, candidate dumps) never reach the browser.
      const known = err as { status?: number };
      if (typeof known.status === "number") {
        return json({ error: singleLine((err as Error).message) }, known.status);
      }
      console.error(singleLine(err instanceof Error ? err.stack ?? err.message : err));
      return json({ error: "internal error" }, 500);
    }
  }

  // ---- status / config ----
  if (route === "status" && req.method === "GET") {
    const free = await freeSpace(state.destination);
    return json({
      sourceRoot: state.sourceRoot,
      destination: state.destination,
      /** Browser-side path logic follows the server's platform, not its own. */
      pathSeparator: REL_SEP,
      caseInsensitive: CASE_INSENSITIVE,
      platform: process.platform,
      arch: process.arch,
      canPickFolder: canPickFolder(),
      budgetBytes: state.budgetBytes,
      ratio: currentRatio(),
      ratios: state.ratios,
      outputFormat: state.policy.outputFormat,
      formats: OUTPUT_FORMATS.map((id) => FORMAT_SPECS[id]),
      policy: state.policy,
      scanned: Boolean(state.scan),
      scannedAt: state.scan?.scannedAt ?? null,
      fileCount: state.scan?.files.length ?? 0,
      freeBytes: free,
      freeLabel: bytes(free),
      magick: state.magick
        ? {
            version: state.magick.version,
            path: state.magick.path,
            avifWritable: state.magick.avifWritable,
            libheif: state.magick.libheif,
            formats: state.magick.formats,
          }
        : null,
      // Expose whichever job is live so a refreshed page can re-attach to it,
      // not just a paused one.
      liveJobId: liveJob()?.id ?? null,
      pausedJobId: pausedJob()?.id ?? null,
      redundantRoots: state.redundantRoots,
      projects: projectList(),
      recentSources: loadPersistedSettings().recentSources ?? [],
    });
  }

  if (route === "config" && req.method === "POST") {
    const body = await readBody<Partial<State>>(req);

    // INSV-1: validate against the *prospective* values before mutating
    // anything, so a rejected change cannot leave the server half-configured.
    const nextSource = typeof body.sourceRoot === "string" ? body.sourceRoot : state.sourceRoot;
    const nextDest = typeof body.destination === "string" ? body.destination : state.destination;
    safeDestination(nextSource, nextDest);

    if (typeof body.destination === "string") state.destination = body.destination;
    if (typeof body.budgetBytes === "number" && Number.isFinite(body.budgetBytes) && body.budgetBytes > 0) {
      state.budgetBytes = body.budgetBytes;
    }
    if (Array.isArray(body.redundantRoots)) state.redundantRoots = body.redundantRoots;
    applyPolicyUpdate(body.policy);

    // A new source invalidates everything derived from the old one,
    // including the redundancy banner (FS-10).
    if (nextSource !== state.sourceRoot) {
      state.sourceRoot = nextSource;
      recordRecentSource(state.sourceRoot);
      state.scan = null;
      state.index = new Map();
      state.dedupe = null;
      state.verify = null;
      state.dates = null;
      state.sync = null;
      state.lastPreview = null;
      state.lastEstimate = null;
      state.ratios = defaultRatios();
      state.redundantRoots = [];
      resetVideoScanState();
    }

    savePersistedSettings({
      sourceRoot: state.sourceRoot,
      destination: state.destination,
      budgetBytes: state.budgetBytes,
      policy: state.policy,
    });

    return json({
      ok: true,
      sourceRoot: state.sourceRoot,
      destination: state.destination,
      needsScan: state.scan === null,
    });
  }

  /** Lightweight validation so the UI can reject a bad path before scanning. */
  if (route === "validate" && req.method === "POST") {
    const body = await readBody<{ sourceRoot?: string; destination?: string }>(req);
    const src = body.sourceRoot ?? state.sourceRoot;
    const dst = body.destination ?? state.destination;
    try {
      assertDestinationSafe(src, dst);
    } catch (err) {
      return json({ ok: false, error: (err as Error).message });
    }
    let exists = false;
    let readable = false;
    try {
      const st = await stat(src);
      exists = true;
      readable = st.isDirectory();
    } catch { /* not there */ }
    return json({ ok: exists && readable, exists, isDirectory: readable });
  }

  // ---- native folder picker via PowerShell dialog ----
  if (route === "pick" && req.method === "POST") {
    const body = await readBody<{ title?: string }>(req);
    const picked = await folderPicker(body.title ?? "Choose a folder");
    return json({ path: picked });
  }

  // ---- scan ----
  if (route === "scan" && req.method === "POST") {
    const body = await readBody<{ sourceRoot?: string }>(req);
    // INSV-1: validate the prospective source BEFORE any mutation. Assigning
    // first let a rejected (e.g. destination-parent) path corrupt
    // state.sourceRoot even though the request failed.
    const previousSource = state.sourceRoot;
    let nextSource = state.sourceRoot;
    if (typeof body.sourceRoot === "string" && body.sourceRoot.trim()) {
      nextSource = body.sourceRoot.trim();
      safeDestination(nextSource, state.destination);
    }
    return withBusy("scan", "A library scan is already running. Wait for it to finish.", async () => {
      state.sourceRoot = nextSource;
      const t0 = Date.now();
      state.scan = await scanLibrary(state.sourceRoot);
      // Exact-match lookups later; a linear find over 11k files per request was
      // showing up on every compare and passthrough call.
      state.index = new Map(state.scan.files.map((f) => [f.rel, f]));
      state.dedupe = null;
      state.verify = null;
      state.dates = null;
      state.sync = null;
      state.lastPreview = null;
      state.lastEstimate = null;
      // Measured ratios describe the current source. Keep them on a re-scan of
      // the same folder; reset only when the source actually changed.
      if (state.sourceRoot !== previousSource) {
        state.ratios = defaultRatios();
        state.redundantRoots = [];
        resetVideoScanState();
      }
      recordRecentSource(state.sourceRoot);
      savePersistedSettings({
        sourceRoot: state.sourceRoot,
        destination: state.destination,
      });
      return json({
        ok: true,
        durationMs: Date.now() - t0,
        tree: state.scan.tree,
        totals: state.scan.totals,
        deadFolders: state.scan.deadFolders,
        riskyNames: state.scan.riskyNames,
        skipped: state.scan.skipped,
        projects: projectList(),
        recentSources: loadPersistedSettings().recentSources ?? [],
      });
    });
  }

  // ---- preview: apply policy, no disk I/O beyond the cached scan ----
  if (route === "preview" && req.method === "POST") {
    const body = await readBody<{ policy?: Partial<Policy> }>(req);
    applyPolicyUpdate(body.policy);
    const preview = currentPreview();
    const budget: BudgetPlan = planBudget(preview, state.budgetBytes);
    // A single scan covers photos and videos. Show the video projection too so
    // the budget meter reflects the whole library, not just the active tab.
    const videoPreview = state.scan ? currentVideoPreview(state.scan) : null;
    const otherModeBytes = videoPreview?.estOutputBytes ?? 0;
    const otherModeCount = videoPreview?.estOutputFiles ?? 0;
    const health = await runHealthCheck(
      state.sourceRoot,
      state.destination,
      preview.estOutputBytes,
      state.policy.outputFormat,
    );
    return json({
      convert: preview.convert.length,
      copy: preview.copy.length,
      skip: preview.skip.length,
      sourceBytes: preview.sourceBytes,
      estOutputBytes: preview.estOutputBytes,
      estOutputFiles: preview.estOutputFiles,
      ratio: preview.compressionRatio,
      outputFormat: state.policy.outputFormat,
      formatLabel: FORMAT_SPECS[state.policy.outputFormat].label,
      byFolder: preview.byFolder,
      budget,
      otherModeBytes,
      otherModeCount,
      health,
      // health already measured free space for the destination.
      freeBytes: health.freeBytes,
    });
  }

  // ---- estimate: real sample ----
  if (route === "estimate" && req.method === "POST") {
    const body = await readBody<{ sampleSize?: number; jobs?: number; policy?: Partial<Policy> }>(req);
    return withBusy("estimate", "An estimate is already running. Wait for it to finish.", async () => {
      applyPolicyUpdate(body.policy);
      const preview = currentPreview();
      const magick = requireMagick();
      const format = state.policy.outputFormat;
      const est = await estimateFromSample({
        convert: preview.convert,
        copy: preview.copy,
        sourceRoot: state.sourceRoot,
        magickPath: magick.path,
        policy: state.policy,
        jobs: clampInt(body.jobs ?? 4, 4, 1, 16),
        sampleSize: clampInt(body.sampleSize ?? 120, 120, 10, 2000),
        flatRatio: state.ratios[format],
        signal: req.signal,
      });
      state.lastEstimate = est;
      // A real measurement becomes the flat ratio for this format only.
      if (est.method === "sampled" && est.sampleSize > 0) state.ratios[format] = est.ratio;
      return json(est);
    });
  }

  // ---- duplicates ----
  if (route === "duplicates" && req.method === "POST") {
    const body = await readBody<{ maxHash?: number; policy?: Partial<Policy> }>(req);
    return withBusy("duplicates", "A duplicate scan is already running. Wait for it to finish.", async () => {
      if (body.policy) {
        state.policy = normalisePolicy({ ...state.policy, ...body.policy });
      }
      if (!state.scan) throw new HttpError(400, "Scan the library first.");
      const res = await findDuplicates(state.scan.files, state.policy, {
        maxHash: Math.min(body.maxHash ?? 6000, 40000),
        signal: req.signal,
      });
      state.dedupe = res;
      return json({
        groups: res.groups.slice(0, 300),
        groupCount: res.groups.length,
        duplicateFiles: res.duplicateFiles,
        duplicateBytes: res.duplicateBytes,
        hashedFiles: res.hashedFiles,
        durationMs: res.durationMs,
        truncated: res.truncated,
        candidateCount: res.candidateCount,
        // D-2: surface real hash-error data instead of silently dropping it.
        hashErrors: res.hashErrors,
        unhashedGroups: res.unhashedGroups,
      });
    });
  }

  // ---- metadata / dates ----
  if (route === "dates" && req.method === "POST") {
    const body = await readBody<{ limit?: number; policy?: Partial<Policy> }>(req);
    return withBusy("dates", "A date report is already running. Wait for it to finish.", async () => {
      if (body.policy) {
        state.policy = normalisePolicy({ ...state.policy, ...body.policy });
      }
      if (!state.scan) throw new HttpError(400, "Scan the library first.");
      const preview = currentPreview();
      const magick = requireMagick();
      const all = [...preview.convert, ...preview.copy];
      // Say so rather than silently auditing a subset.
      const limit = Math.max(1, Math.min(body.limit ?? 4000, 20000));
      const subset = all.slice(0, limit);
      const facts: ImageFacts[] = await identifyMany(
        magick.path, subset.map((d) => d.file.abs), 8, req.signal,
      );
      const report = buildDateReport(facts);
      const absToRel = new Map(subset.map((d) => [d.file.abs, d.file.rel]));
      const undatedRel = report.undated.map((p) => absToRel.get(p) ?? path.relative(state.sourceRoot, p));
      state.dates = { ...report, undated: undatedRel };
      return json({
        ...report,
        scanned: facts.length,
        inScope: all.length,
        truncated: all.length > subset.length,
        omitted: all.length - subset.length,
        undated: undatedRel.slice(0, 500),
      });
    });
  }

  // ---- health ----
  if (route === "health" && req.method === "GET") {
    const preview = state.scan ? currentPreview() : null;
    const report = await runHealthCheck(
      state.sourceRoot, state.destination, preview?.estOutputBytes ?? 0,
      state.policy.outputFormat,
    );
    return json(report);
  }

  // ---- shutdown ----
  if (route === "shutdown" && req.method === "POST") {
    const live = liveJob();
    if (live) {
      throw new HttpError(
        409,
        live.state === "paused"
          ? "A conversion is paused. Resume or cancel it before closing the server."
          : "A conversion is running. Pause or cancel it before closing the server.",
      );
    }
    if (installProgress().running) {
      throw new HttpError(409, "An ImageMagick download is in progress. Wait for it to finish before closing the server.");
    }
    if (isVideoJobActive()) {
      throw new HttpError(409, "A video job or FFmpeg download is active. Wait for it to finish or cancel it before closing the server.");
    }

    // Let this response reach the browser, then stop the listener and exit.
    // A job or install can slip past the checks above in the window; give a
    // live engine a grace period to finish rather than yanking it at a fixed
    // 300 ms, but never wait past 5 s.
    setTimeout(() => {
      const deadline = Date.now() + 5000;
      const poll = () => {
        // MED-1: include the two in-flight run-start locks. A run accepted just
        // before shutdown has no live job yet during its awaited pre-flight;
        // without these, the poll would call requestShutdown() and silently
        // drop that accepted run.
        if ((!liveJob() && !isVideoJobActive() && !isRunStarting() && !isVideoRunStarting()) || Date.now() >= deadline) requestShutdown?.();
        else setTimeout(poll, 250);
      };
      poll();
    }, 300);
    return json({ ok: true, message: "Compakta is shutting down." });
  }

  // ---- managed ImageMagick: local install + GitHub update check ----
  if (route === "imagemagick" && req.method === "GET") {
    if (!state.magick) {
      // Pick up a copy the user dropped into imagemagick/ since startup.
      try { state.magick = findMagick(); } catch { state.magick = null; }
    }
    return json(await checkForUpdate({ current: state.magick }));
  }

  if (route === "imagemagick/check" && req.method === "GET") {
    if (!state.magick) {
      try { state.magick = findMagick(); } catch { state.magick = null; }
    }
    return json(await checkForUpdate({
      current: state.magick,
      force: url.searchParams.get("force") === "1",
    }));
  }

  if (route === "imagemagick/progress" && req.method === "GET") {
    return json(installProgress());
  }

  if (route === "imagemagick/install" && req.method === "POST") {
    // Replacing the binaries under running encoders is not safe on Windows.
    const live = liveJob();
    if (live || isRunStarting()) {
      throw new HttpError(
        409,
        live?.state === "paused"
          ? "A conversion is paused. Resume or cancel it before updating ImageMagick."
          : "A conversion is running. Pause or cancel it before updating ImageMagick.",
      );
    }
    if (installProgress().running) {
      throw new HttpError(409, "An ImageMagick download is already in progress.");
    }

    let result;
    try {
      result = await installLatest();
    } catch (err) {
      throw new HttpError(502, (err as Error).message);
    }

    // The old binary may be cached in state; probe the new one immediately so
    // the very next conversion uses it.
    state.magick = null;
    try { state.magick = findMagick(); } catch { /* reported by the next health call */ }

    return json({
      ok: true,
      ...result,
      // S-4: explicit consumer for the producer in imagemagick.ts (also rides
      // along in `...result`). Lets health/UI surface "integrity not verified".
      integrityNote: result.integrityNote,
      installed: state.magick
        ? {
            version: state.magick.version,
            path: state.magick.path,
            avifWritable: state.magick.avifWritable,
            formats: state.magick.formats,
          }
        : null,
    });
  }

  // ---- Compakta self-update routes ----
  if (route === "app/update" && req.method === "GET") {
    return json(await checkAppUpdate(url.searchParams.get("force") === "1"));
  }

  if (route === "app/update/check" && req.method === "GET") {
    return json(await checkAppUpdate(url.searchParams.get("force") === "1"));
  }

  if (route === "app/update/progress" && req.method === "GET") {
    return json(getAppUpdateProgress());
  }

  if (route === "app/update/download" && req.method === "POST") {
    void downloadAppUpdate().catch((err) => {
      console.warn("App update download error:", err);
    });
    return json({ ok: true, ...getAppUpdateProgress() });
  }

  if (route === "app/update/dismiss" && req.method === "POST") {
    const body = await readBody<{ version?: string }>(req).catch(() => ({ version: undefined }));
    dismissAppUpdate(body.version);
    return json({ ok: true });
  }

  if (route === "app/update/apply" && req.method === "POST") {
    const live = liveJob();
    if (live) {
      throw new HttpError(
        409,
        live.state === "paused"
          ? "A conversion is paused. Resume or cancel it before updating Compakta."
          : "A conversion is currently running. Wait for it to complete or cancel it before updating Compakta.",
      );
    }
    // A video job or ffmpeg download would survive only half of an apply.
    if (isVideoJobActive()) {
      throw new HttpError(
        409,
        "A video conversion or FFmpeg download is active. Wait for it to finish or cancel it before updating Compakta.",
      );
    }
    const result = await applyAppUpdate();
    // AU-3: applyAppUpdate() may refuse at its own re-check (a job/install
    // started between this route's guards and the actual apply). Surface that
    // as a clean 409 instead of a 200 with ok:false.
    if (!result.ok) throw new HttpError(409, result.message);
    return json(result);
  }

  // ---- quality preview: render one image at several qualities ----
  if (route === "compare" && req.method === "POST") {
    const body = await readBody<{
      rel: string;
      qualities?: number[];
      format?: string;
      nativeFormats?: string[];
    }>(req);
    if (!state.scan) throw new HttpError(400, "Scan the library first.");
    const file = findFileByRel(body.rel);
    if (!file) throw new HttpError(404, `Not in scan: ${body.rel}`);

    const format = isOutputFormat(body.format) ? body.format : state.policy.outputFormat;
    const spec = FORMAT_SPECS[format];
    const magick = requireMagick();
    const support = magick.formats[format];
    if (!support?.writable) {
      throw new HttpError(
        400,
        `${spec.label} cannot be encoded by this ImageMagick build ` +
          `(format mode "${support?.mode || "missing"}").`,
      );
    }

    const rawQualities = Array.isArray(body.qualities) ? body.qualities : spec.compareQualities;
    const cleanQualities = [...new Set(
      rawQualities
        .map((q) => Math.round(Number(q)))
        .filter((q) => Number.isFinite(q) && q >= spec.quality.min && q <= spec.quality.max),
    )].slice(0, 6);
    const qualities = cleanQualities.length > 0 ? cleanQualities : spec.compareQualities.slice(0, 6);
    // Fixed location. This previously took a destination from the request
    // body, which let a caller direct writes anywhere on the machine.
    const outDir = previewCacheDir;
    await ensureDir(outDir);

    const srcArg = sourceArgFor(file.abs, file.ext, format, false);
    const speed = state.policy.heicSpeed;
    // Linux WebKitGTK (notably Ubuntu/Debian -DUSE_AVIF=OFF) cannot decode AVIF
    // natively, so honour the browser's probed formats or default safely on Linux desktop.
    const clientNative = Array.isArray(body.nativeFormats)
      ? new Set(body.nativeFormats.map((e) => String(e).toLowerCase()))
      : IS_LINUX && (process.env.COMPAKTA_DESKTOP || process.env.PICMAGIK_DESKTOP)
        ? new Set([...NATIVE_IMAGE_EXTS].filter((e) => e !== "avif"))
        : NATIVE_IMAGE_EXTS;
    const browserCanRenderVariant = clientNative.has(spec.ext.toLowerCase());
    const originalNeedsProxy = !clientNative.has(file.ext.toLowerCase());
    const orderedVariants: Array<{ quality: number; label: string; url: string; bytes: number } | null> =
      new Array(qualities.length).fill(null);
    const errors: string[] = [];
    const stamp = `${file.size}-${Math.round(file.mtime)}`;

    await runPool(
      qualities,
      req.signal,
      async (q, index) => {
        const release = await previewSemaphore.acquire(req.signal);
        try {
          const name = `cmp-${hashRel(file.rel)}-${stamp}-${format}-q${q}-s${speed}.${spec.ext}`;
          const out = path.join(outDir, name);
          const partOut = path.join(outDir, `part-${process.pid}-${Date.now()}-${name}`);

          let size = 0;
          try {
            const st = await stat(out);
            size = st.size;
          } catch { /* not cached yet */ }

          if (size === 0) {
            try {
              size = await runMagickAtomic(
                magick.path,
                partOut,
                out,
                (target) => buildEncoderArgs({ srcArg, out: target, format, quality: q, speed }),
                req.signal,
                45_000,
              );
            } catch (err) {
              if (req.signal.aborted) return;
              errors.push(`q${q}: ${(err as Error).message}`);
              return;
            }
          }

          let displayName = name;
          if (!browserCanRenderVariant) {
            const proxyName = `${name}.png`;
            const proxyOut = path.join(outDir, proxyName);
            const partProxy = path.join(outDir, `part-${process.pid}-${Date.now()}-${proxyName}`);
            if (!existsSync(proxyOut)) {
              try {
                await runMagickAtomic(
                  magick.path,
                  partProxy,
                  proxyOut,
                  (target) => [`${out}[0]`, "-auto-orient", "-colorspace", "sRGB", `PNG:${target}`],
                  req.signal,
                  30_000,
                );
              } catch (err) {
                if (req.signal.aborted) return;
                errors.push(`q${q} preview decode: ${(err as Error).message}`);
                return;
              }
            }
            displayName = proxyName;
          }

          orderedVariants[index] = {
            quality: q,
            label: qualityDisplay(format, q),
            url: `/preview-cache/${displayName}`,
            bytes: size,
          };
        } finally {
          release();
        }
      },
      () => req.signal.aborted,
      () => 2,
    );

    if (req.signal.aborted) throw new HttpError(499, "Cancelled");
    const variants = orderedVariants.filter((v): v is NonNullable<typeof v> => v !== null);

    return json({
      rel: file.rel,
      format,
      formatLabel: spec.label,
      originalUrl: `/api/source-file?rel=${encodeURIComponent(file.rel)}${originalNeedsProxy ? "&proxy=1" : ""}`,
      originalBytes: file.size,
      originalExt: file.ext,
      mtime: file.mtime,
      variants,
      errors,
    });
  }

  // ---- source file passthrough (read-only) for the compare view ----
  if (route === "source-file" && req.method === "GET") {
    if (!state.scan) throw new HttpError(404, "No scan.");
    const rel = url.searchParams.get("rel");
    const file = findFileByRel(rel);
    if (!file) throw new HttpError(404, "Not in scan.");

    const ext = file.ext.toLowerCase();
    const forceProxy = url.searchParams.get("proxy") === "1";
    const accept = req.headers.get("accept") ?? "";
    const browserLacksAvif = ext === "avif" && accept.includes("image/") && !accept.includes("image/avif");

    // 1. Browser-native formats (JPG, PNG, WebP, AVIF, GIF, BMP): serve directly
    if (NATIVE_IMAGE_EXTS.has(ext) && !forceProxy && !browserLacksAvif) {
      if (file.size > MAX_PASSTHROUGH_BYTES) {
        throw new HttpError(
          413,
          `Too large to preview in the browser: ${(file.size / 1024 ** 3).toFixed(2)} GB`,
        );
      }
      return new Response(Bun.file(file.abs), {
        headers: {
          "content-type": IMAGE_MIME[ext] ?? "image/jpeg",
          "x-content-type-options": "nosniff",
          "cache-control": "no-store",
        },
      });
    }

    // 2. Non-native photo formats (HEIC, HEIF, TIFF, DNG, CR2, ARW, NEF, etc.):
    //    Decode via ImageMagick into a full-resolution JPEG in previewCacheDir
    if (file.category === "image" || file.category === "raw") {
      await ensureDir(previewCacheDir);
      const origCacheName = cacheKeyFor(file, "cmp-orig");
      const origCachePath = path.join(previewCacheDir, origCacheName);

      if (!existsSync(origCachePath)) {
        const magick = requireMagick();
        const release = await previewSemaphore.acquire(req.signal);
        try {
          if (!existsSync(origCachePath)) {
            const partPath = path.join(previewCacheDir, `part-${process.pid}-${Date.now()}-${origCacheName}`);
            await runMagickAtomic(
              magick.path,
              partPath,
              origCachePath,
              (target) => [`${file.abs}[0]`, "-auto-orient", "-colorspace", "sRGB", "-quality", "96", `JPEG:${target}`],
              req.signal,
              25_000,
            );
          }
        } finally {
          release();
        }
      }

      const cached = Bun.file(origCachePath);
      return new Response(cached, {
        headers: {
          "content-type": "image/jpeg",
          "content-length": String(cached.size),
          "cache-control": "no-store",
        },
      });
    }

    throw new HttpError(415, `Not a displayable image: .${file.ext}`);
  }

  // ---- thumbnail generator & cache ----
  if (route === "thumb" && req.method === "GET") {
    if (!state.scan) throw new HttpError(404, "No scan.");
    const rel = url.searchParams.get("rel");
    const file = findFileByRel(rel);
    if (!file) throw new HttpError(404, "Not in scan.");

    await ensureDir(previewCacheDir);
    const thumbName = cacheKeyFor(file, "thumb");
    const thumbPath = path.join(previewCacheDir, thumbName);

    if (file.category === "video") {
      const pngPath = thumbPath.replace(/\.jpg$/, ".png");
      if (!existsSync(pngPath)) {
        let ffmpeg = null;
        try { ffmpeg = findFfmpeg(); } catch { ffmpeg = null; }
        if (ffmpeg) {
          // INSv-MED: ffmpeg children must respect the same bound the magick
          // paths honor — a gallery of video thumbs is otherwise N concurrent
          // spawns. Double-check inside so a raced neighbor's output is kept.
          const release = await previewSemaphore.acquire(req.signal);
          try {
            if (!existsSync(pngPath)) {
              await extractVideoFramePng(ffmpeg.ffmpegPath, file.abs, 1.0, pngPath);
            }
          } finally {
            release();
          }
        }
      }
      if (existsSync(pngPath)) {
        return new Response(Bun.file(pngPath), {
          headers: {
            "content-type": "image/png",
            "cache-control": "public, max-age=86400",
          },
        });
      }
      throw new HttpError(404, "No video thumbnail available");
    }

    if (!existsSync(thumbPath)) {
      // Photos (image or raw)
      let magick: MagickInfo | null = state.magick;
      if (!magick) {
        try { magick = findMagick(); } catch { magick = null; }
      }
      if (magick) {
        const release = await previewSemaphore.acquire(req.signal);
        try {
          if (!existsSync(thumbPath)) {
            const partPath = path.join(previewCacheDir, `part-${process.pid}-${Date.now()}-${thumbName}`);
            await runMagickAtomic(
              magick.path,
              partPath,
              thumbPath,
              (target) => [`${file.abs}[0]`, "-auto-orient", "-thumbnail", "96x96^", "-gravity", "center", "-extent", "96x96", "-quality", "80", `JPEG:${target}`],
              req.signal,
              12_000,
            );
          }
        } finally {
          release();
        }
      } else if (IMAGE_MIME[file.ext.toLowerCase()]) {
        return new Response(Bun.file(file.abs), {
          headers: {
            "content-type": IMAGE_MIME[file.ext.toLowerCase()],
            "cache-control": "public, max-age=86400",
          },
        });
      } else {
        throw new HttpError(415, `Unsupported image format: .${file.ext}`);
      }
    }

    return new Response(Bun.file(thumbPath), {
      headers: {
        "content-type": "image/jpeg",
        "cache-control": "public, max-age=86400",
      },
    });
  }

  // ---- high-resolution expanded preview for lightbox ----
  if (route === "view-image" && req.method === "GET") {
    if (!state.scan) throw new HttpError(404, "No scan.");
    const rel = url.searchParams.get("rel");
    const file = findFileByRel(rel);
    if (!file) throw new HttpError(404, "Not in scan.");

    const ext = file.ext.toLowerCase();
    const forceProxy = url.searchParams.get("proxy") === "1";
    const accept = req.headers.get("accept") ?? "";
    const browserLacksAvif = ext === "avif" && accept.includes("image/") && !accept.includes("image/avif");
    // Directly stream browser-native formats if within size limit
    if (NATIVE_IMAGE_EXTS.has(ext) && !forceProxy && !browserLacksAvif && file.size <= MAX_PASSTHROUGH_BYTES) {
      return new Response(Bun.file(file.abs), {
        headers: {
          "content-type": IMAGE_MIME[ext] ?? "image/jpeg",
          "cache-control": "no-store",
        },
      });
    }

    if (file.category === "video") {
      let ffmpeg = null;
      try { ffmpeg = findFfmpeg(); } catch { ffmpeg = null; }
      if (ffmpeg) {
        const framePath = path.join(previewCacheDir, cacheKeyFor(file, "frame").replace(/\.jpg$/, ".png"));
        if (!existsSync(framePath)) {
          await ensureDir(previewCacheDir);
          // INSv-MED: bound the ffmpeg spawn like the thumb route does.
          const release = await previewSemaphore.acquire(req.signal);
          try {
            if (!existsSync(framePath)) {
              await extractVideoFramePng(ffmpeg.ffmpegPath, file.abs, 1.0, framePath);
            }
          } finally {
            release();
          }
        }
        if (existsSync(framePath)) {
          return new Response(Bun.file(framePath), {
            headers: {
              "content-type": "image/png",
              "cache-control": "public, max-age=86400",
            },
          });
        }
      }
      throw new HttpError(404, "No video preview available");
    }

    // For HEIC, RAW, TIFF or non-native formats, transcode to a screen-sized cached JPEG
    await ensureDir(previewCacheDir);
    const viewName = cacheKeyFor(file, "view");
    const viewPath = path.join(previewCacheDir, viewName);

    if (!existsSync(viewPath)) {
      let magick: MagickInfo | null = state.magick;
      if (!magick) {
        try { magick = findMagick(); } catch { magick = null; }
      }
      if (!magick) {
        if (IMAGE_MIME[ext]) {
          return new Response(Bun.file(file.abs), {
            headers: {
              "content-type": IMAGE_MIME[ext],
              "cache-control": "no-store",
            },
          });
        }
        throw new HttpError(500, "ImageMagick required to preview this image");
      }
      const release = await previewSemaphore.acquire(req.signal);
      try {
        if (!existsSync(viewPath)) {
          const partPath = path.join(previewCacheDir, `part-${process.pid}-${Date.now()}-${viewName}`);
          await runMagickAtomic(
            magick.path,
            partPath,
            viewPath,
            (target) => [`${file.abs}[0]`, "-auto-orient", "-resize", "2048x2048>", "-quality", "85", `JPEG:${target}`],
            req.signal,
            20_000,
          );
        }
      } finally {
        release();
      }
    }

    return new Response(Bun.file(viewPath), {
      headers: {
        "content-type": "image/jpeg",
        "cache-control": "public, max-age=86400",
      },
    });
  }

  // ---- run ----
  if (route === "run" && req.method === "POST") {
    const body = await readBody<{ jobs?: number; cpuLimit?: number; overwrite?: boolean; policy?: Partial<Policy>; onlyNew?: boolean }>(req);
    // INSV-3: a mid-install run would sandwich half-swapped magick binaries
    // between queue planning and the pool's first encode.
    if (isInstallInProgress()) {
      throw new HttpError(409, "ImageMagick is being installed — retry after it finishes.");
    }
    // A paused job still owns its queue, so a fresh run must not start over it.
    // runStarting covers the await window below (onlyNew analysis, ensureDir):
    // two rapid requests could otherwise both pass the live check and both
    // start encodes over the same output paths.
    const live = liveJob();
    if (live || runStarting) {
      throw new HttpError(
        409,
        live && live.state === "paused"
          ? "A conversion is paused. Resume or cancel it before starting another."
          : "A conversion is already running or starting.",
      );
    }
    if (isVideoJobActive()) {
      throw new HttpError(
        409,
        "A video conversion is currently active. Pause or cancel it before starting a photo conversion.",
      );
    }
    runStarting = true;
    try {
      const magick = requireMagick();
      const requested = mergePolicyUpdate(state.policy, body.policy);
      const requestedSupport = magick.formats[requested.outputFormat];
      if (!requestedSupport?.writable) {
        throw new HttpError(
          400,
          `${FORMAT_SPECS[requested.outputFormat].label} cannot be encoded by this ImageMagick build ` +
            `(format mode "${requestedSupport?.mode || "missing"}").`,
        );
      }
      if (body.policy) applyPolicyUpdate(body.policy);
      const preview = currentPreview();
      safeDestination(state.sourceRoot, state.destination);
      await ensureDir(state.destination);

      let decisions = [...preview.convert, ...preview.copy];

      // "Convert new only": drop anything already converted and current.
      if (body.onlyNew) {
        const report = await analyseSync(decisions, state.sourceRoot, state.destination, state.policy);
        decisions = pendingOnly(decisions, report);
        state.sync = report;
      }

      if (decisions.length === 0) throw new HttpError(400, "Nothing to do - everything is already converted.");

      const jobs = clampInt(body.jobs ?? 2, 2, 1, 32);
      const cpuLimit = clampInt(body.cpuLimit ?? 70, 70, 10, 100);
      const job = newJob();

      void job.start({
        decisions,
        sourceRoot: state.sourceRoot,
        destination: state.destination,
        magickPath: magick.path,
        policy: state.policy,
        jobs,
        cpuLimit,
        overwrite: Boolean(body.overwrite),
        qualityLabel: state.policy.qualities,
      });

      return json({
        jobId: job.id,
        total: decisions.length,
        jobs,
        cpuLimit,
        outputFormat: state.policy.outputFormat,
      });
    } finally {
      // job.start() flips the job to "running" synchronously (jobs.ts execute()
      // sets state before its first await), so releasing here still leaves
      // liveJob() populated for any request racing this return.
      runStarting = false;
    }
  }

  // ---- SSE progress ----
  if (route.startsWith("stream/") && req.method === "GET") {
    const job = getJob(route.slice("stream/".length));
    if (!job) throw new HttpError(404, "Unknown job.");

    const encoder = new TextEncoder();
    let ping: ReturnType<typeof setInterval> | null = null;
    let detach: (() => void) | null = null;

    const cleanup = () => {
      detach?.();
      detach = null;
      if (ping) {
        clearInterval(ping);
        ping = null;
      }
    };

    const stream = new ReadableStream({
      start(controller) {
        const send = (p: unknown) => {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(p, jsonReplacer)}\n\n`));
          } catch {
            cleanup();
          }
        };
        send({ type: "hello", jobId: job.id, state: job.state });
        if (job.lastTerminalEvent) {
          send(job.lastTerminalEvent);
          controller.close();
          return;
        }
        if (job.state === "done" || job.state === "cancelled" || job.state === "failed") {
          controller.close();
          return;
        }
        job.on("progress", send);
        ping = setInterval(() => {
          try { controller.enqueue(encoder.encode(": ping\n\n")); } catch { cleanup(); }
        }, 15_000);
        // Drop the listener when the stream ends. Without this, every page
        // refresh left another listener holding a dead response.
        detach = () => { job.off("progress", send); };
      },
      cancel() {
        cleanup();
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  }

  if (route.startsWith("jobs/") && req.method === "POST") {
    const job = getJob(route.slice("jobs/".length));
    if (!job) throw new HttpError(404, "Unknown job.");
    const body = await readBody<{ jobs?: number; cpuLimit?: number }>(req);
    // The pool reads this before every dispatch, and in-flight processes are updated immediately.
    const res: { ok: boolean; jobs?: number; cpuLimit?: number } = { ok: true };
    if (body.jobs !== undefined) res.jobs = job.setJobs(Number(body.jobs));
    if (body.cpuLimit !== undefined) res.cpuLimit = job.setCpuLimit(Number(body.cpuLimit));
    return json(res);
  }

  if (route.startsWith("pause/") && req.method === "POST") {
    const job = getJob(route.slice("pause/".length));
    if (!job) throw new HttpError(404, "Unknown job.");
    // Graceful: in-flight encodes are allowed to finish and land on disk.
    const ok = job.pause();
    return json({ ok, state: job.state, message: ok ? "Pausing…" : `Cannot pause from "${job.state}".` });
  }

  if (route.startsWith("resume/") && req.method === "POST") {
    const job = getJob(route.slice("resume/".length));
    if (!job) throw new HttpError(404, "Unknown job.");
    if (job.state !== "paused") {
      throw new HttpError(409, `Cannot resume from "${job.state}".`);
    }
    void job.resume().catch((err) => console.error("[server] photo resume failed:", err));
    return json({ ok: true, state: job.state, total: job.progress().total });
  }

  if (route === "job/state" && req.method === "GET") {
    const job = getJob(url.searchParams.get("id") ?? "");
    if (!job) throw new HttpError(404, "Unknown job.");
    return json({ id: job.id, ...job.progress() });
  }

  if (route.startsWith("cancel/") && req.method === "POST") {
    const job = getJob(route.slice("cancel/".length));
    if (!job) throw new HttpError(404, "Unknown job.");
    // CORE: Job.cancel() is async (Promise<boolean>). Await it so a rejected
    // persist can't surface as an unhandled rejection and the finish event
    // cannot race this response. (The video tab uses video/jobs.ts — untouched.)
    await job.cancel();
    return json({ ok: true, state: job.state });
  }

  // ---- incremental sync: what is already converted ----
  if (route === "sync" && req.method === "POST") {
    const body = await readBody<{ policy?: Partial<Policy> }>(req);
    return withBusy("sync", "A sync analysis is already running. Wait for it to finish.", async () => {
      if (!state.scan) throw new HttpError(400, "Scan the library first.");
      applyPolicyUpdate(body.policy);
      const preview = currentPreview();
      const decisions = [...preview.convert, ...preview.copy];

      const report = await analyseSync(
        decisions, state.sourceRoot, state.destination, state.policy,
      );
      state.sync = report;

      const pending = pendingOnly(decisions, report);

      return json({
        total: report.total,
        newCount: report.newCount,
        changedCount: report.changedCount,
        upToDateCount: report.upToDateCount,
        pendingCount: report.pendingCount,
        pendingSourceBytes: report.pendingSourceBytes,
        orphanCount: report.orphanCount,
        orphanBytes: report.orphanBytes,
        orphans: report.orphans.slice(0, 25),
        estOutputBytes: Math.round(
          pending.filter((d) => d.verdict === "convert").reduce((a, d) => a + d.file.size, 0) *
            currentRatio() * Math.max(1, state.policy.qualities.length) +
          pending.filter((d) => d.verdict === "copy").reduce((a, d) => a + d.file.size, 0),
        ),
        outputFormat: state.policy.outputFormat,
        durationMs: report.durationMs,
        // A slice for the panel; the full list is thousands of rows.
        changed: report.entries.filter((e) => e.state === "changed").slice(0, 50),
        sampleNew: report.entries.filter((e) => e.state === "new").slice(0, 25),
      });
    });
  }

  // ---- opt-in orphan cleanup ----
  if (route === "sync/clean-orphans" && req.method === "POST") {
    const body = await readBody<{ confirm?: boolean }>(req);
    // This route deletes files in the destination. A stray double-click or a
    // misfired automation must not sweep orphans: require the explicit flag.
    if (body.confirm !== true) {
      throw new HttpError(409, "Pass { confirm: true } to delete orphaned outputs.");
    }
    return withBusy("clean-orphans", "An orphan cleanup is already running. Wait for it to finish.", async () => {
      if (!state.scan) throw new HttpError(400, "Scan the library first.");
      const preview = currentPreview();
      const decisions = [...preview.convert, ...preview.copy];
      const report = await analyseSync(decisions, state.sourceRoot, state.destination, state.policy);
      const result = await cleanOrphans(state.destination, report.allOrphans);
      state.sync = null;
      return json(result);
    });
  }

  // ---- verify the outputs of a finished run ----
  if (route === "verify" && req.method === "POST") {
    const body = await readBody<{ jobId?: string; limit?: number }>(req);
    const job = body.jobId ? getJob(body.jobId) : undefined;
    if (!job) throw new HttpError(400, "Pass jobId of a finished run.");
    // Results accumulate across resume (jobs.ts appends each segment's
    // results), but a running or paused job still has files mid-encode:
    // in-flight outputs look empty and would be reported as failures.
    if (job.state === "running" || job.state === "paused") {
      throw new HttpError(
        409,
        `That job is ${job.state}. Let it finish, then verify.`,
      );
    }
    if (!job.results.length) throw new HttpError(400, "That run produced no files to verify.");

    const magick = requireMagick();
    const report = await verifyOutputs(job.results, magick.path, {
      jobs: 8,
      limit: Math.max(1, Math.min(body.limit ?? 200, 5000)),
    });
    state.verify = report;
    return json({
      checked: report.checked,
      passed: report.passed,
      failed: report.failed,
      dateSurvived: report.dateSurvived,
      durationMs: report.durationMs,
      // Only surface problems by default; the full list can be huge.
      rows: report.rows.filter((r) => !r.ok).slice(0, 200),
    });
  }

  // ---- run manifests / undo ----
  if (route === "manifests" && req.method === "GET") {
    const list = await manifestsFor(state.destination);
    return json({
      manifests: list.map((m) => ({
        id: m.id, createdAt: m.createdAt, summary: m.summary,
        quality: m.quality, outputFormat: m.outputFormat ?? "avif",
        destination: m.destination,
      })),
    });
  }

  if (route === "undo" && req.method === "POST") {
    if (liveJob() || isRunStarting()) {
      throw new HttpError(409, "Cannot undo while a conversion is running or paused.");
    }
    const body = await readBody<{ id: string; dryRun?: boolean }>(req);
    const list = await manifestsFor(state.destination);
    const manifest = list.find((m) => m.id === body.id);
    if (!manifest) throw new HttpError(404, "No such manifest.");
    const result = await undoManifest(manifest, { dryRun: body.dryRun });
    return json(result);
  }

  // ---- open destination folder in OS explorer ----
  if (route === "open-destination" && req.method === "POST") {
    const body = await readBody<{ destination?: string }>(req);
    const target = body.destination || state.destination;
    if (!target) throw new HttpError(400, "Destination is not set.");
    // INSv-MED: only folders inside the configured destination may be opened.
    // A client-supplied arbitrary path must not become an explorer-open
    // primitive for any directory on the machine.
    // LOW-2: check containment BEFORE existence. Otherwise an outside path
    // yields 404 (exists) vs 400 (missing), an existence oracle for arbitrary
    // directories even though the response never opens them.
    const resolved = pathKey(path.resolve(target));
    const destPrefix = pathKey(path.resolve(state.destination));
    if (resolved !== destPrefix) {
      const prefix = destPrefix.endsWith(path.sep) ? destPrefix : destPrefix + path.sep;
      if (!resolved.startsWith(prefix)) {
        throw new HttpError(400, "Requested folder is outside the configured destination.");
      }
    }
    if (!(await dirExists(target))) {
      throw new HttpError(404, `Destination directory does not exist on disk: ${target}`);
    }
    const ok = openPathInOs(target);
    return json({ ok, target });
  }

  throw new HttpError(404, `Unknown route: /api/${route}`);
}

/** Adjacent projects, so the redundancy banner can tell you where else a copy lives. */
function projectList(): string[] {
  const base = path.dirname(path.resolve(state.sourceRoot));
  if (!existsSync(base)) return [];
  try {
    return readdirSync(base, { withFileTypes: true })
      .filter((d: any) => d.isDirectory() && !/^(\$|System)/i.test(d.name))
      .map((d: any) => path.join(base, d.name))
      .filter((p: string) => pathKey(path.resolve(p)) !== pathKey(path.resolve(state.sourceRoot)))
      .slice(0, 40);
  } catch {
    return [];
  }
}

function hashRel(rel: string): string {
  let h = 0;
  for (let i = 0; i < rel.length; i++) h = (Math.imul(31, h) + rel.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** PowerShell FolderBrowserDialog - gives a real native picker with no extra deps. */
function powershellFolderPicker(title: string): Promise<string | null> {
  const safeTitle = String(title ?? "Choose a folder").replace(/[\r\n\0]/g, " ").slice(0, 120);
  const ps = `
Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = $env:COMPAKTA_PICK_TITLE
$d.ShowNewFolderButton = $true
if ($d.ShowDialog() -eq 'OK') { Write-Output $d.SelectedPath }
$d.Dispose()
`;
  return new Promise((resolve) => {
    const c = spawn("powershell.exe", ["-NoProfile", "-STA", "-Command", ps], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, COMPAKTA_PICK_TITLE: safeTitle },
    });
    let out = "";
    c.stdout.on("data", (d) => { out += String(d); });
    c.on("error", () => resolve(null));
    c.on("close", () => resolve(out.trim() || null));
  });
}

type LinuxPicker = { cmd: string; args: (title: string) => string[] };

/**
 * Zenity first, then KDialog. Both are common, dependency-free GUI pickers;
 * without either the UI falls back to typing a path.
 */
function linuxPickers(): LinuxPicker[] {
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return [];
  const out: LinuxPicker[] = [];
  if (Bun.which("zenity")) {
    out.push({
      cmd: "zenity",
      args: (title) => ["--file-selection", "--directory", `--title=${title}`],
    });
  }
  if (Bun.which("kdialog")) {
    out.push({
      cmd: "kdialog",
      args: (title) => ["--getexistingdirectory", homedir(), "--title", title],
    });
  }
  return out;
}

function canPickFolder(): boolean {
  return IS_WINDOWS || (IS_LINUX && linuxPickers().length > 0);
}

function runPicker(cmd: string, args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    c.stdout.on("data", (d) => { out += String(d); });
    c.on("error", () => resolve({ code: null, out: "" }));
    c.on("close", (code) => resolve({ code, out }));
  });
}

async function folderPicker(title: string): Promise<string | null> {
  if (IS_WINDOWS) return powershellFolderPicker(title);
  if (!IS_LINUX) return null;
  for (const picker of linuxPickers()) {
    const { code, out } = await runPicker(picker.cmd, picker.args(title));
    if (code === 0) return out.trim() || null;
    // A non-zero exit is a cancel, not a missing tool: do not open a second
    // dialog just because the user changed their mind.
    return null;
  }
  return null;
}

// --------------------------------------------------------------------------
// Static
// --------------------------------------------------------------------------

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/** Compare previews are written in the selected output format. */
const PREVIEW_MIME: Record<string, string> = {
  ".jxl": "image/jxl",
  ".avif": "image/avif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".jp2": "image/jp2",
  ".jpg": "image/jpeg",
  ".png": "image/png",
};

async function serveStatic(pathname: string): Promise<Response> {
  if (pathname === "/" || pathname === "") pathname = "/index.html";

  // Preview cache holds only generated previews; it is writable app state.
  if (pathname.startsWith("/preview-cache/")) {
    const name = path.basename(pathname);
    const file = path.resolve(previewCacheDir, name);
    try {
      const cached = Bun.file(file);
      if (!(await cached.exists())) {
        return new Response("not found", { status: 404 });
      }
      return new Response(cached, {
        headers: {
          "content-type": PREVIEW_MIME[path.extname(name).toLowerCase()]
            ?? "application/octet-stream",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    } catch {
      return new Response("not found", { status: 404 });
    }
  }

  const rel = pathname.replace(/^\/+/, "");
  const file = path.resolve(publicDir, rel);
  if (!pathKey(file).startsWith(pathKey(publicRoot()))) {
    return new Response("forbidden", { status: 403 });
  }
  try {
    const pubFile = Bun.file(file);
    if (!(await pubFile.exists())) {
      return new Response("not found", { status: 404 });
    }
    return new Response(pubFile, {
      headers: {
        "content-type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
}

const publicRoot = () => path.resolve(publicDir) + path.sep;

// --------------------------------------------------------------------------
// Boot
// --------------------------------------------------------------------------

export type ServerOptions = {
  /** Listening port. 0 picks a free one; defaults to PORT or 5178. */
  port?: number;
  /** Static browser files (index.html, app.js, ...). */
  publicDir?: string;
  /** Writable folder for generated quality-comparison previews. */
  previewCacheDir?: string;
  /** Open the default browser once the listener is ready. */
  open?: boolean;
};

export type RunningServer = {
  server: ReturnType<typeof Bun.serve>;
  port: number;
  stop: () => void;
};

/**
 * Start the local server. The browser launchers call the source entrypoint,
 * which starts this immediately; the Electrobun main process calls it with a
 * free port and the packaged resource/cache folders.
 */
export function startServer(options: ServerOptions = {}): RunningServer {
  if (options.publicDir) publicDir = path.resolve(options.publicDir);
  if (options.previewCacheDir) previewCacheDir = path.resolve(options.previewCacheDir);

  // AU-3: the self-updater must never exit() while work is live. Inject one
  // busy-guard source of truth covering every signal:
  //   - photo job          -> liveJob()
  //   - photo run starting -> isRunStarting() (run accepted, pre-flight await)
  //   - video job          -> isVideoJobActive() (video/routes.ts:101-103)
  //   - video run starting -> isVideoRunStarting() (run accepted, pre-flight await)
  //   - FFmpeg install     -> isVideoJobActive() already includes
  //                           getFfmpegInstallProgress().running (no new helper needed)
  //   - ImageMagick install-> isInstallInProgress() (imagemagick.ts:127)
  // MED-1: the two *Starting flags close the gap where a run is accepted but
  // no job is "running" yet. Without them the 1 s exit timer at app-update.ts
  // reports idle and process.exit(0) silently drops the accepted run.
  setApplyBusyGuard(() => {
    const photo = liveJob();
    if (photo) return `a photo conversion is ${photo.state}`;
    if (isRunStarting()) return "a photo conversion is starting";
    if (isVideoJobActive()) return "a video conversion or FFmpeg install is active";
    if (isVideoRunStarting()) return "a video conversion is starting";
    if (isInstallInProgress()) return "an ImageMagick install is in progress";
    return null;
  });

  // FS-09: a non-numeric or out-of-range PORT (shell typos, stale exports)
  // must not crash the boot; warn and fall back to the default.
  const DEFAULT_PORT = 5178;
  const RAW_PORT = process.env.PORT?.trim();
  const envPort = (() => {
    if (RAW_PORT === undefined || RAW_PORT === "") return DEFAULT_PORT;
    const n = Number(RAW_PORT);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      console.warn(`Ignoring invalid PORT="${RAW_PORT}"; using ${DEFAULT_PORT}.`);
      return DEFAULT_PORT;
    }
    return n;
  })();
  const PORT = options.port ?? envPort;

  const server = Bun.serve({
    port: PORT,
    hostname: "127.0.0.1",
    idleTimeout: 255,

    async fetch(req) {
      // Reject DNS-rebinding and cross-origin requests to the unauthenticated
      // localhost API. The Host header must point at loopback, and any Origin
      // that is present must be loopback too.
      const host = req.headers.get("host") ?? "";
      if (host && !/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(host)) {
        return new Response("Forbidden host", { status: 403 });
      }
      const origin = req.headers.get("origin");
      if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin)) {
        return new Response("Forbidden origin", { status: 403 });
      }
      const url = new URL(req.url);
      // FS-02/INSV-guard: fetch metadata pins API access to same-tab usage.
      // Cross-site GETs (e.g. a planted <img src="/api/...">) are blocked —
      // they leak scanned-file existence via 200/404/415 and can trigger
      // magick/ffmpeg child spawns. Static + /preview-cache stay open so the
      // compare panel's <img> elements keep working, and same-origin GETs
      // (page fetches, SSE) are unaffected.
      if (url.pathname.startsWith("/api/")) {
        const site = req.headers.get("sec-fetch-site");
        if (site && site !== "same-origin" && site !== "same-site" && site !== "none") {
          return new Response("Forbidden cross-site request", { status: 403 });
        }
        // Wave-1 matrix: POST bodies are application/json only (the bundled
        // client always sets the header); text/plain or form posts are abuse.
        if (req.method === "POST") {
          const ct = req.headers.get("content-type") ?? "";
          if (ct && !/^application\/([a-z0-9.+-]+\+)?json\b/i.test(ct)) {
            return new Response("Unsupported Media Type", { status: 415 });
          }
        }
      }
      try {
        if (url.pathname.startsWith("/api/")) {
          return await handleApi(url.pathname, req, url);
        }
        return await serveStatic(url.pathname);
      } catch (err) {
        if (err instanceof HttpError) return json({ error: err.message }, err.status);
        // INSV-1/FS-04: internal failures must not shape the response. Detail
        // goes to stderr single-line (messages embed user paths); the browser
        // gets a shapeless body.
        console.error(singleLine(err instanceof Error ? err.stack ?? err.message : err));
        return json({ error: "internal error" }, 500);
      }
    },
  });

  requestShutdown = () => {
    server.stop(true);
    process.exit(0);
  };

  const boundPort = server.port ?? PORT;

  // Surface obvious misconfiguration early rather than on the first request.
  try {
    state.magick = findMagick();
    console.log(`ImageMagick : ${state.magick.version}`);
    console.log(`AVIF        : ${state.magick.avifMode} ${state.magick.avifWritable ? "writable" : "READ ONLY"}`);
  } catch (err) {
    console.error(`WARNING: ${(err as Error).message.split("\n")[0]}`);
  }

  console.log(`Source      : ${state.sourceRoot}`);
  console.log(`Destination : ${state.destination}`);
  console.log(`\n  Compakta running at http://127.0.0.1:${boundPort}\n`);

  if (options.open ?? process.argv.includes("--open")) {
    openBrowser(`http://127.0.0.1:${boundPort}`);
  }

  void prunePreviewCache(previewCacheDir);

  return { server, port: boundPort, stop: () => server.stop(true) };
}

function openBrowser(target: string): void {
  const opener = IS_WINDOWS ? "cmd" : IS_LINUX ? "xdg-open" : "open";
  const args = IS_WINDOWS ? ["/c", "start", "", target] : [target];
  spawn(opener, args, {
    windowsHide: true,
    detached: true,
    stdio: "ignore",
  }).on("error", () => {
    console.warn(`Could not open a browser automatically. Open ${target} manually.`);
  }).unref();
}

// The desktop main process imports this module and starts the server itself.
if (import.meta.main && !process.env.COMPAKTA_DESKTOP && !process.env.PICMAGIK_DESKTOP) {
  startServer();
}