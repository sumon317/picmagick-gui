/**
 * Compakta - local media optimization server.
 *
 * Bun.serve() on localhost only. Every route either reads state or shells out
 * to the local ImageMagick build. The source tree is never written to.
 */
import { existsSync } from "node:fs";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
  findMagick, assertDestinationSafe, freeSpace, ensureDir, type MagickInfo,
} from "./paths.ts";
import { estimateFromSample, type Estimate } from "./estimate.ts";
import { findDuplicates, type DedupeResult } from "./dedupe.ts";
import { identifyMany, buildDateReport, type DateReport, type ImageFacts } from "./meta.ts";
import { verifyOutputs, type VerifyReport } from "./verify.ts";
import { planBudget, type BudgetPlan } from "./budget.ts";
import { runHealthCheck, type HealthReport } from "./health.ts";
import { Job, getJob, liveJob, pausedJob, newJob, manifestsFor, undoManifest } from "./jobs.ts";
import { analyseSync, cleanOrphans, pendingOnly, type SyncReport } from "./sync.ts";
import { formatBytes } from "./convert.ts";
import { checkForUpdate, installLatest, installProgress } from "./imagemagick.ts";
import {
  applyAppUpdate,
  checkAppUpdate,
  dismissAppUpdate,
  downloadAppUpdate,
  getAppUpdateProgress,
} from "./app-update.ts";
import { CASE_INSENSITIVE, IS_LINUX, IS_WINDOWS, pathKey, REL_SEP } from "./platform.ts";
import { PREVIEW_CACHE_DIR, PUBLIC_DIR } from "./appdirs.ts";
import { loadPersistedSettings, savePersistedSettings } from "./settings.ts";
import {
  currentVideoPreview,
  handleVideoApi,
  isVideoJobActive,
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
  if (!state.magick) state.magick = findMagick();
  return state.magick;
}

const currentRatio = () => state.ratios[state.policy.outputFormat];

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

async function readBody<T>(req: Request): Promise<T> {
  try { return (await req.json()) as T; }
  catch { throw new HttpError(400, "Malformed JSON body."); }
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
      const status = (err as { status?: number })?.status ?? 500;
      return json({ error: (err as Error).message }, status);
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
    });
  }

  if (route === "config" && req.method === "POST") {
    const body = await readBody<Partial<State>>(req);

    // Validate against the *prospective* values before mutating anything, so a
    // rejected change cannot leave the server half-configured.
    const nextSource = typeof body.sourceRoot === "string" ? body.sourceRoot : state.sourceRoot;
    const nextDest = typeof body.destination === "string" ? body.destination : state.destination;
    assertDestinationSafe(nextSource, nextDest);

    if (typeof body.destination === "string") state.destination = body.destination;
    if (typeof body.budgetBytes === "number") state.budgetBytes = body.budgetBytes;
    if (Array.isArray(body.redundantRoots)) state.redundantRoots = body.redundantRoots;
    applyPolicyUpdate(body.policy);

    // A new source invalidates everything derived from the old one.
    if (nextSource !== state.sourceRoot) {
      state.sourceRoot = nextSource;
      state.scan = null;
      state.index = new Map();
      state.dedupe = null;
      state.verify = null;
      state.dates = null;
      state.sync = null;
      state.lastPreview = null;
      state.lastEstimate = null;
      state.ratios = defaultRatios();
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
    const previousSource = state.sourceRoot;
    if (body.sourceRoot) {
      state.sourceRoot = body.sourceRoot;
      assertDestinationSafe(state.sourceRoot, state.destination);
    }
    const t0 = Date.now();
    state.scan = await scanLibrary(state.sourceRoot);
    // Exact-match lookups later; a linear find over 11k files per request was
    // showing up on every compare and passthrough call.
    state.index = new Map(state.scan.files.map((f) => [f.rel, f]));
    state.dedupe = null;
    state.verify = null;
    state.dates = null;
    state.lastEstimate = null;
    // Measured ratios describe the current source. Keep them on a re-scan of
    // the same folder; reset only when the source actually changed.
    if (state.sourceRoot !== previousSource) state.ratios = defaultRatios();
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
      jobs: Math.max(1, Math.min(body.jobs ?? 4, 16)),
      sampleSize: Math.max(10, Math.min(body.sampleSize ?? 120, 2000)),
      flatRatio: state.ratios[format],
    });
    state.lastEstimate = est;
    // A real measurement becomes the flat ratio for this format only.
    if (est.method === "sampled" && est.sampleSize > 0) state.ratios[format] = est.ratio;
    return json(est);
  }

  // ---- duplicates ----
  if (route === "duplicates" && req.method === "POST") {
    if (!state.scan) throw new HttpError(400, "Scan the library first.");
    const body = await readBody<{ maxHash?: number; policy?: Partial<Policy> }>(req);
    if (body.policy) {
      state.policy = normalisePolicy({ ...state.policy, ...body.policy });
    }
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
    });
  }

  // ---- metadata / dates ----
  if (route === "dates" && req.method === "POST") {
    if (!state.scan) throw new HttpError(400, "Scan the library first.");
    const body = await readBody<{ limit?: number; policy?: Partial<Policy> }>(req);
    if (body.policy) {
      state.policy = normalisePolicy({ ...state.policy, ...body.policy });
    }
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
    state.dates = report;
    return json({
      ...report,
      scanned: facts.length,
      inScope: all.length,
      truncated: all.length > subset.length,
      omitted: all.length - subset.length,
      undated: report.undated.slice(0, 500),
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
    setTimeout(() => requestShutdown?.(), 300);
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
    if (live) {
      throw new HttpError(
        409,
        live.state === "paused"
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
    const result = await applyAppUpdate();
    return json(result);
  }

  // ---- quality preview: render one image at several qualities ----
  if (route === "compare" && req.method === "POST") {
    const body = await readBody<{ rel: string; qualities?: number[]; format?: string }>(req);
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

    const qualities = (body.qualities ?? spec.compareQualities).slice(0, 6);
    // Fixed location. This previously took a destination from the request
    // body, which let a caller direct writes anywhere on the machine.
    const outDir = previewCacheDir;
    await ensureDir(outDir);

    const srcArg = sourceArgFor(file.abs, file.ext, format, false);
    const speed = state.policy.heicSpeed;
    // Browsers natively render avif, webp, jpeg, and png in <img> tags;
    // jxl, heic, and jp2 need a decoded PNG proxy to display in WebView2/Chromium.
    const browserCanRenderVariant = NATIVE_IMAGE_EXTS.has(spec.ext.toLowerCase());
    const variants: { quality: number; label: string; url: string; bytes: number }[] = [];
    const errors: string[] = [];

    for (const q of qualities) {
      // Include format and speed in the name so changing either slider cannot
      // serve a stale preview from the disposable cache.
      const name = `cmp-${hashRel(file.rel)}-${format}-q${q}-s${speed}.${spec.ext}`;
      const out = path.join(outDir, name);
      await new Promise<void>((resolve) => {
        const c = spawn(magick.path, buildEncoderArgs({
          srcArg, out, format, quality: q, speed,
        }), {
          windowsHide: true,
          stdio: "ignore",
          env: { ...process.env, MAGICK_THREAD_LIMIT: "1" },
        });
        c.on("close", () => resolve());
        c.on("error", () => resolve());
      });
      let size = 0;
      try {
        size = (await stat(out)).size;
        if (size === 0) { errors.push(`q${q}: encoder wrote nothing`); continue; }
      } catch { errors.push(`q${q}: no output produced`); continue; }

      let displayName = name;
      if (!browserCanRenderVariant) {
        const proxyName = `${name}.png`;
        const proxyOut = path.join(outDir, proxyName);
        await new Promise<void>((resolve) => {
          const c = spawn(
            magick.path,
            [`${out}[0]`, "-auto-orient", "-colorspace", "sRGB", `PNG:${proxyOut}`],
            { windowsHide: true, stdio: "ignore", env: { ...process.env, MAGICK_THREAD_LIMIT: "1" } },
          );
          c.on("close", () => resolve());
          c.on("error", () => resolve());
        });
        if (existsSync(proxyOut)) {
          displayName = proxyName;
        }
      }

      variants.push({
        quality: q,
        label: qualityDisplay(format, q),
        url: `/preview-cache/${displayName}`,
        bytes: size,
      });
    }

    return json({
      rel: file.rel,
      format,
      formatLabel: spec.label,
      originalUrl: `/api/source-file?rel=${encodeURIComponent(file.rel)}`,
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

    // 1. Browser-native formats (JPG, PNG, WebP, AVIF, GIF, BMP): serve directly
    if (NATIVE_IMAGE_EXTS.has(ext)) {
      if (file.size > MAX_PASSTHROUGH_BYTES) {
        throw new HttpError(
          413,
          `Too large to preview in the browser: ${(file.size / 1024 ** 3).toFixed(2)} GB`,
        );
      }
      const data = await readFile(file.abs);
      return new Response(data, {
        headers: {
          "content-type": IMAGE_MIME[ext] ?? "image/jpeg",
          "content-length": String(file.size),
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
            await new Promise<void>((resolve, reject) => {
              const child = spawn(
                magick.path,
                [
                  `${file.abs}[0]`,
                  "-auto-orient",
                  "-colorspace",
                  "sRGB",
                  "-quality",
                  "96",
                  `JPEG:${origCachePath}`,
                ],
                { windowsHide: true, stdio: "ignore" },
              );
              const onAbort = () => {
                try { child.kill(); } catch {}
                reject(new HttpError(499, "Cancelled"));
              };
              req.signal.addEventListener("abort", onAbort, { once: true });
              const timer = setTimeout(() => {
                try { child.kill(); } catch {}
                reject(new Error("Original preview decode timed out"));
              }, 20_000);
              child.on("close", (code) => {
                clearTimeout(timer);
                req.signal.removeEventListener("abort", onAbort);
                if (code === 0) resolve();
                else reject(new Error(`ImageMagick decode exited with ${code}`));
              });
              child.on("error", (err) => {
                clearTimeout(timer);
                req.signal.removeEventListener("abort", onAbort);
                reject(err);
              });
            });
          }
        } finally {
          release();
        }
      }

      const data = await readFile(origCachePath);
      return new Response(data, {
        headers: {
          "content-type": "image/jpeg",
          "content-length": String(data.byteLength),
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
          await extractVideoFramePng(ffmpeg.ffmpegPath, file.abs, 1.0, pngPath);
        }
      }
      if (existsSync(pngPath)) {
        const data = await readFile(pngPath);
        return new Response(data, {
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
            await new Promise<void>((resolve, reject) => {
              const child = spawn(magick.path, [
                `${file.abs}[0]`,
                "-auto-orient",
                "-thumbnail", "96x96^",
                "-gravity", "center",
                "-extent", "96x96",
                "-quality", "80",
                thumbPath,
              ], { windowsHide: true, stdio: "ignore" });
              const onAbort = () => {
                try { child.kill(); } catch { /* already gone */ }
                reject(new HttpError(499, "Cancelled"));
              };
              req.signal.addEventListener("abort", onAbort, { once: true });
              const timer = setTimeout(() => {
                try { child.kill(); } catch { /* already gone */ }
                reject(new Error("Thumbnail generation timed out"));
              }, 8000);
              child.on("close", (code) => {
                clearTimeout(timer);
                req.signal.removeEventListener("abort", onAbort);
                if (code === 0) resolve();
                else reject(new Error(`Thumbnail generation failed with code ${code}`));
              });
              child.on("error", (err) => {
                clearTimeout(timer);
                req.signal.removeEventListener("abort", onAbort);
                reject(err);
              });
            });
          }
        } finally {
          release();
        }
      } else if (IMAGE_MIME[file.ext.toLowerCase()]) {
        const data = await readFile(file.abs);
        return new Response(data, {
          headers: {
            "content-type": IMAGE_MIME[file.ext.toLowerCase()],
            "cache-control": "public, max-age=86400",
          },
        });
      } else {
        throw new HttpError(415, `Unsupported image format: .${file.ext}`);
      }
    }

    const data = await readFile(thumbPath);
    return new Response(data, {
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
    // Directly stream browser-native formats if within size limit
    if (NATIVE_IMAGE_EXTS.has(ext) && file.size <= MAX_PASSTHROUGH_BYTES) {
      const data = await readFile(file.abs);
      return new Response(data, {
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
          await extractVideoFramePng(ffmpeg.ffmpegPath, file.abs, 1.0, framePath);
        }
        if (existsSync(framePath)) {
          const data = await readFile(framePath);
          return new Response(data, {
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
          const data = await readFile(file.abs);
          return new Response(data, {
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
        await new Promise<void>((resolve, reject) => {
          const child = spawn(magick.path, [
            `${file.abs}[0]`,
            "-auto-orient",
            "-resize", "2048x2048>",
            "-quality", "85",
            viewPath,
          ], { windowsHide: true, stdio: "ignore" });
          const onAbort = () => {
            try { child.kill(); } catch { /* already gone */ }
            reject(new HttpError(499, "Cancelled"));
          };
          req.signal.addEventListener("abort", onAbort, { once: true });
          const timer = setTimeout(() => {
            try { child.kill(); } catch { /* already gone */ }
            reject(new Error("Preview generation timed out"));
          }, 15000);
          child.on("close", (code) => {
            clearTimeout(timer);
            req.signal.removeEventListener("abort", onAbort);
            if (code === 0) resolve();
            else reject(new Error(`Preview generation failed with code ${code}`));
          });
          child.on("error", (err) => {
            clearTimeout(timer);
            req.signal.removeEventListener("abort", onAbort);
            reject(err);
          });
        });
      } finally {
        release();
      }
    }

    const data = await readFile(viewPath);
    return new Response(data, {
      headers: {
        "content-type": "image/jpeg",
        "cache-control": "public, max-age=86400",
      },
    });
  }

  // ---- run ----
  if (route === "run" && req.method === "POST") {
    const body = await readBody<{ jobs?: number; cpuLimit?: number; overwrite?: boolean; policy?: Partial<Policy>; onlyNew?: boolean }>(req);
    // A paused job still owns its queue, so a fresh run must not start over it.
    const live = liveJob();
    if (live) {
      throw new HttpError(
        409,
        live.state === "paused"
          ? "A conversion is paused. Resume or cancel it before starting another."
          : "A conversion is already running.",
      );
    }
    if (isVideoJobActive()) {
      throw new HttpError(
        409,
        "A video conversion is currently active. Pause or cancel it before starting a photo conversion.",
      );
    }
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
    assertDestinationSafe(state.sourceRoot, state.destination);
    await ensureDir(state.destination);

    let decisions = [...preview.convert, ...preview.copy];

    // "Convert new only": drop anything already converted and current.
    if (body.onlyNew) {
      const report = await analyseSync(decisions, state.sourceRoot, state.destination, state.policy);
      decisions = pendingOnly(decisions, report);
      state.sync = report;
    }

    if (decisions.length === 0) throw new HttpError(400, "Nothing to do - everything is already converted.");

    const jobs = Math.max(1, Math.min(body.jobs ?? 2, 32));
    const cpuLimit = Math.max(10, Math.min(Number(body.cpuLimit) || 70, 100));
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
  }

  // ---- SSE progress ----
  if (route.startsWith("stream/") && req.method === "GET") {
    const job = getJob(route.slice("stream/".length));
    if (!job) throw new HttpError(404, "Unknown job.");

    const encoder = new TextEncoder();
    let ping: ReturnType<typeof setInterval> | null = null;
    let detach: (() => void) | null = null;

    const stream = new ReadableStream({
      start(controller) {
        const send = (p: unknown) => {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(p, jsonReplacer)}\n\n`));
          } catch { /* client went away */ }
        };
        send({ type: "hello", jobId: job.id, state: job.state });
        job.on("progress", send);
        ping = setInterval(() => {
          try { controller.enqueue(encoder.encode(": ping\n\n")); } catch { /* ignore */ }
        }, 15_000);
        // Drop the listener when the stream ends. Without this, every page
        // refresh left another listener holding a dead response.
        detach = () => { job.off("progress", send); };
      },
      cancel() {
        detach?.();
        if (ping) clearInterval(ping);
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
    void job.resume();
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
    job.cancel();
    return json({ ok: true, state: job.state });
  }

  // ---- incremental sync: what is already converted ----
  if (route === "sync" && req.method === "POST") {
    if (!state.scan) throw new HttpError(400, "Scan the library first.");
    const body = await readBody<{ policy?: Partial<Policy> }>(req);
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
  }

  // ---- opt-in orphan cleanup ----
  if (route === "sync/clean-orphans" && req.method === "POST") {
    if (!state.scan) throw new HttpError(400, "Scan the library first.");
    const preview = currentPreview();
    const decisions = [...preview.convert, ...preview.copy];
    const report = await analyseSync(decisions, state.sourceRoot, state.destination, state.policy);
    const result = await cleanOrphans(state.destination, report.orphans);
    state.sync = null;
    return json(result);
  }

  // ---- verify the outputs of a finished run ----
  if (route === "verify" && req.method === "POST") {
    const body = await readBody<{ jobId?: string; limit?: number }>(req);
    const job = body.jobId ? getJob(body.jobId) : undefined;
    if (!job) throw new HttpError(400, "Pass jobId of a finished run.");
    // A running job has files mid-encode, and a paused-then-resumed one holds
    // only the results of its first segment. Either way the report is wrong:
    // in-flight outputs look empty and are reported as failures.
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
    const body = await readBody<{ id: string; dryRun?: boolean }>(req);
    const list = await manifestsFor(state.destination);
    const manifest = list.find((m) => m.id === body.id);
    if (!manifest) throw new HttpError(404, "No such manifest.");
    const result = await undoManifest(manifest, { dryRun: body.dryRun });
    return json(result);
  }

  throw new HttpError(404, `Unknown route: /api/${route}`);
}

/** Adjacent projects, so the redundancy banner can tell you where else a copy lives. */
function projectList(): string[] {
  const base = path.dirname(path.resolve(state.sourceRoot));
  if (!existsSync(base)) return [];
  const { readdirSync } = require("node:fs");
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
  const ps = `
Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = '${title.replace(/'/g, "''")}'
$d.ShowNewFolderButton = $true
if ($d.ShowDialog() -eq 'OK') { Write-Output $d.SelectedPath }
$d.Dispose()
`;
  return new Promise((resolve) => {
    const c = spawn("powershell.exe", ["-NoProfile", "-STA", "-Command", ps], {
      windowsHide: true,
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
      const data = await readFile(file);
      return new Response(data, {
        headers: {
          "content-type": PREVIEW_MIME[path.extname(name).toLowerCase()]
            ?? "application/octet-stream",
          "cache-control": "no-store",
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
    const data = await readFile(file);
    return new Response(data, {
      headers: { "content-type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream" },
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

  const PORT = options.port ?? Number(process.env.PORT ?? 5178);

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
      try {
        if (url.pathname.startsWith("/api/")) {
          return await handleApi(url.pathname, req, url);
        }
        return await serveStatic(url.pathname);
      } catch (err) {
        if (err instanceof HttpError) return json({ error: err.message }, err.status);
        console.error(err);
        return json({ error: (err as Error).message ?? "internal error" }, 500);
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