/**
 * Compakta self-update management.
 *
 * Checks GitHub Releases for the latest version of Compakta.
 * When an update is available:
 * - Downloads the lean/slim platform installer package in the background into DATA_ROOT/.app-update.
 * - Extracts the installer and verifies the executable.
 * - Holds the ready update without interrupting active conversions.
 * - Applies the update on user confirmation, preserving any bundled ImageMagick
 *   into persistent user storage before launching the installer.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, createReadStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { BUNDLED_MAGICK_DIR, DATA_ROOT, MAGICK_DIR } from "./appdirs.ts";
import { IS_LINUX, IS_WINDOWS } from "./platform.ts";
import { APP_VERSION, compareVersions, isNewerVersion, parseVersion } from "./version.ts";

const REPO = "esconer/compakta";
const FALLBACK_REPO = "esconer/picmagick-gui";
const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const FALLBACK_RELEASE_API = `https://api.github.com/repos/${FALLBACK_REPO}/releases/latest`;
const USER_AGENT = "compakta-app-updater";
const CACHE_MS = 10 * 60 * 1000;

export const UPDATE_DIR = path.join(DATA_ROOT, ".app-update");
export const EXTRACT_DIR = path.join(UPDATE_DIR, "extracted");

export type AppUpdateStage =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "error";

export type LeanAsset = {
  name: string;
  size: number;
  url: string;
  digest: string | null;
};

export type AppUpdateStatus = {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  stage: AppUpdateStage;
  message: string;
  percent: number;
  downloadedBytes: number;
  totalBytes: number;
  releaseNotes: string | null;
  releaseUrl: string | null;
  assetName: string | null;
  installerPath: string | null;
  checkedAt: number | null;
  error: string | null;
  isDesktop: boolean;
  dismissed?: boolean;
  /**
   * Present when the release metadata carried no usable SHA-256 digest, so
   * the update archive could not be verified; surfaces to the UI.
   */
  integrityNote?: string | null;
};

let cachedRelease: { at: number; data: any } | null = null;
let dismissedVersion: string | null = null;

let state: AppUpdateStatus = {
  currentVersion: APP_VERSION,
  latestVersion: null,
  updateAvailable: false,
  stage: "idle",
  message: "",
  percent: 0,
  downloadedBytes: 0,
  totalBytes: 0,
  releaseNotes: null,
  releaseUrl: null,
  assetName: null,
  installerPath: null,
  checkedAt: null,
  error: null,
  isDesktop: Boolean(process.env.COMPAKTA_DESKTOP || process.env.PICMAGIK_DESKTOP),
  integrityNote: null,
};

export function getAppUpdateProgress(): AppUpdateStatus {
  return { ...state };
}

export function dismissAppUpdate(version?: string): void {
  dismissedVersion = version ?? state.latestVersion;
}

/**
 * Pick the lean / slim installer package for the current OS.
 * Matches Compakta packages first, falling back to legacy PicMagickGUI packages.
 */
export function pickLeanAppAsset(
  assets: Array<{ name?: unknown; size?: unknown; browser_download_url?: unknown; digest?: unknown }>,
): LeanAsset | null {
  const candidates: LeanAsset[] = [];

  for (const a of assets) {
    if (typeof a.name !== "string" || typeof a.browser_download_url !== "string") continue;
    const name = a.name;
    const url = a.browser_download_url;
    const size = Number(a.size) || 0;
    const digest = typeof a.digest === "string" ? a.digest : null;

    if (IS_WINDOWS) {
      // Matches win-x64-Compakta-Setup.zip or win-x64-PicMagickGUI-Setup.zip, excluding Full
      if (name.endsWith("-Setup.zip") && !name.includes("Full") && /win.*x64/i.test(name)) {
        candidates.push({ name, size, url, digest });
      }
    } else if (IS_LINUX) {
      // Matches linux-x64-Compakta-Setup.tar.gz or linux-x64-PicMagickGUI-Setup.tar.gz, excluding Full
      if (name.endsWith("-Setup.tar.gz") && !name.includes("Full") && /linux.*x64/i.test(name)) {
        candidates.push({ name, size, url, digest });
      }
    }
  }

  if (candidates.length === 0) return null;

  // 1. Prefer Compakta-named installer
  const compaktaMatch = candidates.find((c) => /compakta/i.test(c.name));
  if (compaktaMatch) return compaktaMatch;

  // 2. Fall back to PicMagickGUI-named installer for backward compatibility
  const legacyMatch = candidates.find((c) => /picmagick/i.test(c.name));
  if (legacyMatch) return legacyMatch;

  return candidates[0];
}

function findInstallerFile(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const list = readdirSync(dir, { withFileTypes: true });
  for (const item of list) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) {
      const nested = findInstallerFile(full);
      if (nested) return nested;
    } else if (item.isFile()) {
      if (IS_WINDOWS && /\.exe$/i.test(item.name)) {
        return full;
      }
      if (IS_LINUX && item.name === "installer") {
        try { chmodSync(full, 0o755); } catch {}
        return full;
      }
    }
  }
  return null;
}

function runAsync(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "ignore", windowsHide: true });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
  });
}

async function extractAppArchive(archive: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  if (IS_WINDOWS) {
    const sys = process.env.SystemRoot ?? "C:\\Windows";
    const tarExe = path.join(sys, "System32", "tar.exe");
    try {
      await runAsync(tarExe, ["-xf", archive, "-C", destDir]);
      return;
    } catch {
      // Fallback: PowerShell Expand-Archive
      const safeArchive = archive.replace(/'/g, "''");
      const safeDest = destDir.replace(/'/g, "''");
      await runAsync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Expand-Archive -LiteralPath '${safeArchive}' -DestinationPath '${safeDest}' -Force`,
      ]);
      return;
    }
  } else {
    await runAsync("tar", ["-xf", archive, "-C", destDir]);
  }
}

let activeCheck: Promise<AppUpdateStatus> | null = null;

/**
 * Human message for failed release checks. Throttled statuses (403/429) get a
 * friendly explanation with the reset time when GitHub provides one.
 */
export function rateLimitMessage(status: number, statusText: string, headers: Headers): string {
  if (status !== 403 && status !== 429) {
    return `GitHub release check failed: HTTP ${status} ${statusText}`;
  }
  const reset = Number(headers.get("x-ratelimit-reset"));
  let when = "";
  if (Number.isFinite(reset) && reset > 0) {
    const minutes = Math.max(1, Math.ceil((reset * 1000 - Date.now()) / 60_000));
    when = ` The limit resets in about ${minutes} minute${minutes === 1 ? "" : "s"}.`;
  }
  const tokenHint = process.env.GITHUB_TOKEN
    ? ""
    : " Setting a GITHUB_TOKEN environment variable raises this limit.";
  return `GitHub is rate-limiting update checks from this network (HTTP ${status}). Try again in a few minutes.${when}${tokenHint}`;
}

export function checkAppUpdate(force = false): Promise<AppUpdateStatus> {
  if (activeCheck) return activeCheck;
  activeCheck = doCheckAppUpdate(force).finally(() => {
    activeCheck = null;
  });
  return activeCheck;
}

async function doCheckAppUpdate(force = false): Promise<AppUpdateStatus> {
  // If download is actively running or ready, keep returning current state
  if (state.stage === "downloading" || state.stage === "ready") {
    return { ...state };
  }

  state.stage = "checking";
  state.error = null;
  state.integrityNote = null;

  try {
    let data: any;
    if (!force && cachedRelease && Date.now() - cachedRelease.at < CACHE_MS) {
      data = cachedRelease.data;
    } else {
      const headers: Record<string, string> = {
        "user-agent": USER_AGENT,
        accept: "application/vnd.github+json",
      };
      if (process.env.GITHUB_TOKEN) {
        headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
      }

      let res = await fetch(RELEASE_API, {
        headers,
        signal: AbortSignal.timeout(15_000),
      });

      // Fallback check if the new repository hasn't published a release yet
      if (res.status === 404 && FALLBACK_REPO) {
        const fallbackRes = await fetch(FALLBACK_RELEASE_API, {
          headers,
          signal: AbortSignal.timeout(15_000),
        });
        if (fallbackRes.ok) {
          res = fallbackRes;
        }
      }

      if (!res.ok) {
        throw new Error(rateLimitMessage(res.status, res.statusText, res.headers));
      }

      data = await res.json();
      cachedRelease = { at: Date.now(), data };
    }

    const tag = String(data.tag_name ?? "").trim();
    const version = tag.replace(/^v/i, "");
    if (!parseVersion(version)) {
      throw new Error("Could not parse version from GitHub release.");
    }

    const newer = isNewerVersion(version, APP_VERSION);
    const assets = Array.isArray(data.assets) ? data.assets : [];
    const picked = pickLeanAppAsset(assets);

    state.checkedAt = Date.now();
    state.latestVersion = version;
    state.releaseNotes = typeof data.body === "string" ? data.body.slice(0, 1500) : null;
    state.releaseUrl = typeof data.html_url === "string" ? data.html_url : null;
    state.assetName = picked?.name ?? null;
    state.totalBytes = picked?.size ?? 0;
    state.isDesktop = Boolean(process.env.COMPAKTA_DESKTOP || process.env.PICMAGIK_DESKTOP);
    state.dismissed = Boolean(dismissedVersion && dismissedVersion === version);

    // Check if installer is already downloaded from a previous run
    const existingInstaller = findInstallerFile(EXTRACT_DIR);
    if (existingInstaller && newer) {
      let extractedVer = "";
      let extractedDigest = "";
      try {
        extractedVer = (await readFile(path.join(EXTRACT_DIR, ".version"), "utf8")).trim();
        extractedDigest = (await readFile(path.join(EXTRACT_DIR, ".digest"), "utf8")).trim().toLowerCase();
      } catch {}
      if (extractedVer === version) {
        // AU-2 / HIGH-2: an extracted installer found on disk is only trusted
        // while its bytes still hash to the digest persisted at download time.
        // .digest holds the SHA-256 of the EXTRACTED INSTALLER (not the
        // archive), so this re-check now compares like-for-like. A mismatch
        // means corruption or tampering: purge it and fall through to the
        // "available" state so a fresh download begins.
        let hashOk = true;
        if (/^[a-f0-9]{64}$/.test(extractedDigest)) {
          try {
            hashOk = (await sha256File(existingInstaller)) === extractedDigest;
          } catch {
            hashOk = false;
          }
          if (!hashOk) {
            console.warn("App update: the extracted installer failed its SHA-256 re-check; discarding it.");
            await rm(EXTRACT_DIR, { recursive: true, force: true }).catch(() => {});
          }
        } else if (extractedDigest === "unverified") {
          state.integrityNote =
            "Release metadata carried no SHA-256 digest — integrity not verified.";
        }
        if (hashOk) {
          state.stage = "ready";
          state.updateAvailable = true;
          state.installerPath = existingInstaller;
          state.percent = 100;
          state.message =
            `Update v${version} is downloaded and ready to apply.` +
            (state.integrityNote ? ` (${state.integrityNote})` : "");
          return { ...state };
        }
      }
    }

    if (newer && picked) {
      state.updateAvailable = true;
      state.stage = "available";
      state.message = `Compakta v${version} is available.`;
    } else {
      state.updateAvailable = false;
      state.stage = "idle";
      state.message = `Compakta is up to date (v${APP_VERSION}).`;
    }

    return { ...state };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    state.stage = "error";
    state.error = msg;
    state.message = `Update check failed: ${msg}`;
    return { ...state };
  }
}

const UPDATE_IDLE_TIMEOUT_MS = 30_000; // re-armed on every received chunk
const UPDATE_TOTAL_TIMEOUT_MS = 15 * 60_000; // generous cap for the whole body
const UPDATE_MAX_ATTEMPTS = 2; // one automatic retry on connection-level failures

/** Distinguishes "server answered with an error status" (usually no retry). */
class UpdateHttpError extends Error {
  constructor(
    readonly status: number,
    readonly statusText: string,
  ) {
    super(`Download failed with HTTP ${status}`);
  }
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * Re-verify an on-disk installer against the digest persisted at download
 * time. That digest is the SHA-256 of the EXTRACTED INSTALLER (not the
 * archive). The "unverified" sentinel means the release carried no usable
 * publisher digest, so integrity cannot be cryptographically linked to the
 * publisher — the caller must surface that note rather than claim verification.
 *
 * `ok:false` is returned only when a trusted digest exists and the bytes do
 * not match (or cannot be hashed); callers must fail closed in that case.
 */
export async function verifyInstallerDigest(
  installerPath: string,
  digestRaw: string | null | undefined,
): Promise<{ ok: boolean; note: string | null }> {
  const digest = (digestRaw ?? "").trim().toLowerCase();
  if (digest === "" || digest === "unverified") {
    return {
      ok: true,
      note: "Release metadata carried no SHA-256 digest — integrity not verified.",
    };
  }
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    return {
      ok: true,
      note: `Release digest format not recognised (${digest.slice(0, 24)}…) — integrity not verified.`,
    };
  }
  let actual: string;
  try {
    actual = await sha256File(installerPath);
  } catch {
    return {
      ok: false,
      note: "Could not hash the installer to verify its integrity; refusing to apply.",
    };
  }
  if (actual !== digest) {
    return {
      ok: false,
      note: "Installer SHA-256 does not match the expected digest; refusing to apply a corrupt or tampered update.",
    };
  }
  return { ok: true, note: null };
}

/**
 * One download attempt: AbortController with an idle timeout re-armed per
 * chunk plus a total deadline; the body is only ever streamed to disk.
 */
async function downloadUpdateFileOnce(
  picked: LeanAsset,
  dest: string,
  onProgress: (received: number, percent: number) => void,
): Promise<{ received: number; hash: string }> {
  const abort = new AbortController();
  let abortReason: string | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      abortReason = `no data received for ${UPDATE_IDLE_TIMEOUT_MS / 1000} s`;
      abort.abort(new Error(abortReason));
    }, UPDATE_IDLE_TIMEOUT_MS);
  };
  const totalDeadline = setTimeout(() => {
    abortReason = `the download exceeded its ${UPDATE_TOTAL_TIMEOUT_MS / 60_000} minute limit`;
    abort.abort(new Error(abortReason));
  }, UPDATE_TOTAL_TIMEOUT_MS);

  try {
    let res: Response;
    try {
      armIdle();
      const headers: Record<string, string> = { "user-agent": USER_AGENT };
      if (process.env.GITHUB_TOKEN) {
        headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
      }
      res = await fetch(picked.url, { headers, signal: abort.signal });
    } catch (err) {
      if (abortReason) throw new Error(`Download failed — ${abortReason}`);
      throw new Error(`Download failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok || !res.body) {
      throw new UpdateHttpError(res.status, res.statusText);
    }

    const total = Number(res.headers.get("content-length")) || picked.size;
    state.totalBytes = total;

    const sink = Bun.file(dest).writer();
    const reader = res.body.getReader();
    const hasher = createHash("sha256");
    let received = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        armIdle();
        if (done) break;
        if (!value) continue;
        received += value.byteLength;
        hasher.update(value);
        await sink.write(value);
        onProgress(received, total > 0 ? Math.min(99, Math.round((received / total) * 100)) : 50);
      }
      await sink.end();
    } catch (err) {
      try { await sink.end(); } catch { /* already failing */ }
      if (abortReason) throw new Error(`Download failed — ${abortReason}`);
      throw new Error(`Download was interrupted: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (picked.size > 0 && received !== picked.size) {
      throw new Error(`Incomplete download: received ${received} of ${picked.size} bytes.`);
    }
    return { received, hash: hasher.digest("hex") };
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    clearTimeout(totalDeadline);
  }
}

/**
 * Download with one automatic retry on connection-level failures (stall,
 * drop, truncation, 5xx, 429). A partial file never survives a retry
 * hand-off or the final failure. Never sticks: every path either completes
 * or throws, so the caller's stage cannot remain "downloading" forever.
 */
async function downloadUpdateFile(
  picked: LeanAsset,
  dest: string,
  onProgress: (received: number, percent: number) => void,
): Promise<{ received: number; hash: string }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= UPDATE_MAX_ATTEMPTS; attempt++) {
    try {
      if (attempt > 1) {
        state.percent = 0;
        state.downloadedBytes = 0;
        onProgress(0, 0);
      }
      return await downloadUpdateFileOnce(picked, dest, onProgress);
    } catch (err) {
      lastError = err;
      await rm(dest, { force: true }).catch(() => {}); // never keep partial bytes
      const status = err instanceof UpdateHttpError ? err.status : 0;
      const retryable = !(err instanceof UpdateHttpError) || status >= 500 || status === 429;
      if (attempt >= UPDATE_MAX_ATTEMPTS || !retryable) break;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Download the lean update package in the background.
 */
export async function downloadAppUpdate(): Promise<void> {
  if (state.stage === "downloading") return;
  if (!state.latestVersion) {
    await checkAppUpdate(true);
  }
  if (!state.updateAvailable || !state.assetName) {
    throw new Error("No update is currently available to download.");
  }

  const picked = cachedRelease?.data?.assets
    ? pickLeanAppAsset(cachedRelease.data.assets)
    : null;
  if (!picked) {
    throw new Error("Could not find a matching installer asset to download.");
  }

  state.stage = "downloading";
  state.percent = 0;
  state.downloadedBytes = 0;
  state.totalBytes = picked.size;
  state.integrityNote = null;
  state.message = `Downloading Compakta v${state.latestVersion}…`;

  const archivePath = path.join(UPDATE_DIR, picked.name);

  // Background download task
  (async () => {
    try {
      await mkdir(UPDATE_DIR, { recursive: true });
      await rm(EXTRACT_DIR, { recursive: true, force: true }).catch(() => {});

      const { received, hash } = await downloadUpdateFile(picked, archivePath, (bytes, percent) => {
        state.downloadedBytes = bytes;
        state.percent = percent;
      });
      state.downloadedBytes = received;

      // F4/AU-2: a missing or unparseable digest must never be a silent skip.
      const expectedSha = picked.digest?.match(/^sha256:([a-f0-9]{64})$/i)?.[1]?.toLowerCase();
      if (!picked.digest) {
        state.integrityNote = "Release metadata carried no SHA-256 digest — integrity not verified.";
        console.warn(`App update: ${state.integrityNote}`);
      } else if (!expectedSha) {
        state.integrityNote =
          `Release digest format not recognised (${picked.digest.trim().slice(0, 24)}…) — integrity not verified.`;
        console.warn(`App update: ${state.integrityNote}`);
      }
      if (expectedSha && hash !== expectedSha) {
        throw new Error("Update archive failed SHA-256 verification.");
      }

      state.percent = 100;
      state.message = "Extracting installer package…";

      // Extract archive
      await extractAppArchive(archivePath, EXTRACT_DIR);

      // Locate installer
      const installer = findInstallerFile(EXTRACT_DIR);
      if (!installer) {
        throw new Error("Installer executable was not found inside the update package.");
      }

      await writeFile(path.join(EXTRACT_DIR, ".version"), `${state.latestVersion}\n`, "utf8");
      // HIGH-2: .digest must describe the bytes we actually re-check — the
      // EXTRACTED INSTALLER, not the downloaded archive. The archive digest
      // (expectedSha) was already used above to verify the download; the
      // restart fast-path and apply-time gate hash the installer file. Storing
      // the archive hash here made hashOk permanently false (different bytes)
      // and forced a full re-download on every restart. When no usable
      // publisher digest existed there is no trusted anchor, so keep the
      // honest "unverified" sentinel instead of a self-generated hash.
      let persistedDigest = "unverified";
      if (expectedSha) {
        persistedDigest = await sha256File(installer);
      }
      await writeFile(
        path.join(EXTRACT_DIR, ".digest"),
        `${persistedDigest}\n`,
        "utf8",
      ).catch(() => {});
      await rm(archivePath, { force: true }).catch(() => {});

      state.installerPath = installer;
      state.stage = "ready";
      state.message =
        `Compakta v${state.latestVersion} is ready to install.` +
        (state.integrityNote ? ` (${state.integrityNote})` : "");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      state.stage = "error";
      state.error = msg;
      state.message = `Update download failed: ${msg}`;
    }
  })();
}

/**
 * Ensure any bundled ImageMagick is backed up into user storage so the lean
 * update retains ImageMagick without needing to redownload.
 */
export async function preserveBundledMagick(): Promise<void> {
  try {
    if (BUNDLED_MAGICK_DIR && existsSync(BUNDLED_MAGICK_DIR)) {
      await mkdir(MAGICK_DIR, { recursive: true });
      const existing = readdirSync(MAGICK_DIR);
      const hasMagick = existing.some(
        (f) => f.startsWith("ImageMagick") || f.endsWith(".AppImage"),
      );
      if (!hasMagick) {
        console.log("Preserving bundled ImageMagick to persistent user data:", MAGICK_DIR);
        cpSync(BUNDLED_MAGICK_DIR, MAGICK_DIR, { recursive: true });
      }
    }
  } catch (err) {
    console.warn("Could not copy bundled ImageMagick to persistent dir:", err);
  }
}

/**
 * Registered by the server at boot: returns a short busy reason while any
 * conversion/encoding work is live (photo job, video job, in-flight ffmpeg),
 * or null when idle. applyAppUpdate refuses (ok:false) while busy so the
 * installer can never kill active runs — the server route maps that
 * refusal to HTTP 409.
 */
export type ApplyBusyGuard = () => string | null;
let applyBusyGuard: ApplyBusyGuard | null = null;

export function setApplyBusyGuard(guard: ApplyBusyGuard | null): void {
  applyBusyGuard = guard;
}

/**
 * Apply the downloaded update:
 * 1. Preserves bundled ImageMagick into persistent user storage.
 * 2. Launches the installer detached.
 * 3. Exits the current app process ONLY once no conversion work is live —
 *    refuses with ok:false otherwise (AU-3: never exit(0) unconditionally).
 */
export async function applyAppUpdate(): Promise<{ ok: boolean; message: string }> {
  if (state.stage !== "ready" || !state.installerPath || !existsSync(state.installerPath)) {
    throw new Error("No update is currently ready to apply.");
  }

  const busyReason = applyBusyGuard?.();
  if (busyReason) {
    console.warn(`App update: refusing to apply while work is live: ${busyReason}`);
    return {
      ok: false,
      message: `Cannot apply the update now: ${busyReason}. Wait for it to finish or cancel it first.`,
    };
  }

  // Preserve ImageMagick before installer runs
  await preserveBundledMagick();

  const installer = state.installerPath;
  console.log("Launching installer:", installer);

  const busyRecheck = applyBusyGuard?.();
  if (busyRecheck) {
    // The guard went busy between validation and launch (a job could have
    // started while we were copying the bundled ImageMagick). Still refuse:
    // nothing was launched, no damage done.
    return {
      ok: false,
      message: `Cannot apply the update now: ${busyRecheck}. Wait for it to finish or cancel it first.`,
    };
  }

  // Apply-time integrity gate (HIGH-2): hash the installer bytes immediately
  // before launch and compare with the digest persisted at download time. A
  // mismatch (or an unreadable installer) fails closed — nothing is spawned.
  // The "unverified" sentinel is not a mismatch: surface the honest note and
  // keep the existing accepted-degradation behaviour.
  let digestRaw: string | null = null;
  try {
    digestRaw = await readFile(path.join(EXTRACT_DIR, ".digest"), "utf8");
  } catch {}
  const integrity = await verifyInstallerDigest(installer, digestRaw);
  state.integrityNote = integrity.note;
  if (!integrity.ok) {
    const message = `Cannot apply the update: ${integrity.note ?? "integrity check failed."}`;
    console.warn(`App update: ${message}`);
    state.error = message;
    return { ok: false, message };
  }

  // Spawn detached so installer outlives this process
  const child = spawn(installer, [], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();

  // Exit so the installer can replace files (locked executables on Windows).
  // AU-3: re-check the busy guard at the EXACT moment of exit. This check and
  // process.exit() run synchronously in one tick, so no job can start between
  // them — the exit can never kill live work. If work became active during the
  // 1 s grace window we spare it: the installer may then need a manual restart
  // to replace locked files, which is safe, unlike killing an active encode.
  setTimeout(() => {
    const busyAtExit = applyBusyGuard?.();
    if (busyAtExit) {
      console.warn(
        `App update: skipped automatic restart because work is live (${busyAtExit}). ` +
          "Restart Compakta manually after the installer finishes.",
      );
      return;
    }
    process.exit(0);
  }, 1000);

  return {
    ok: true,
    message: "Installer launched. Compakta will now restart.",
  };
}
