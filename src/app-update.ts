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
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
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
  assets: Array<{ name?: unknown; size?: unknown; browser_download_url?: unknown }>,
): LeanAsset | null {
  const candidates: LeanAsset[] = [];

  for (const a of assets) {
    if (typeof a.name !== "string" || typeof a.browser_download_url !== "string") continue;
    const name = a.name;
    const url = a.browser_download_url;
    const size = Number(a.size) || 0;

    if (IS_WINDOWS) {
      // Matches win-x64-Compakta-Setup.zip or win-x64-PicMagickGUI-Setup.zip, excluding Full
      if (name.endsWith("-Setup.zip") && !name.includes("Full") && /win.*x64/i.test(name)) {
        candidates.push({ name, size, url });
      }
    } else if (IS_LINUX) {
      // Matches linux-x64-Compakta-Setup.tar.gz or linux-x64-PicMagickGUI-Setup.tar.gz, excluding Full
      if (name.endsWith("-Setup.tar.gz") && !name.includes("Full") && /linux.*x64/i.test(name)) {
        candidates.push({ name, size, url });
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

function extractAppArchive(archive: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true });
  if (IS_WINDOWS) {
    const sys = process.env.SystemRoot ?? "C:\\Windows";
    const tarExe = path.join(sys, "System32", "tar.exe");
    try {
      execFileSync(tarExe, ["-xf", archive, "-C", destDir], {
        stdio: "ignore",
        windowsHide: true,
      });
      return;
    } catch {
      // Fallback: PowerShell Expand-Archive
      const safeArchive = archive.replace(/'/g, "''");
      const safeDest = destDir.replace(/'/g, "''");
      execFileSync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Expand-Archive -LiteralPath '${safeArchive}' -DestinationPath '${safeDest}' -Force`,
      ], {
        stdio: "ignore",
        windowsHide: true,
      });
      return;
    }
  } else {
    execFileSync("tar", ["-xf", archive, "-C", destDir], {
      stdio: "ignore",
    });
  }
}

/**
 * Check GitHub for a new Compakta release.
 * Checks esconer/compakta first; falls back to esconer/picmagick-gui if not found.
 */
export async function checkAppUpdate(force = false): Promise<AppUpdateStatus> {
  // If download is actively running or ready, keep returning current state
  if (state.stage === "downloading" || state.stage === "ready") {
    return { ...state };
  }

  state.stage = "checking";
  state.error = null;

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
        throw new Error(`GitHub release check failed: HTTP ${res.status} ${res.statusText}`);
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

    // Check if installer is already downloaded from previous check
    const existingInstaller = findInstallerFile(EXTRACT_DIR);
    if (existingInstaller && newer) {
      state.stage = "ready";
      state.updateAvailable = true;
      state.installerPath = existingInstaller;
      state.percent = 100;
      state.message = `Update v${version} is downloaded and ready to apply.`;
      return { ...state };
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
  state.message = `Downloading Compakta v${state.latestVersion}…`;

  const archivePath = path.join(UPDATE_DIR, picked.name);

  // Background download task
  (async () => {
    try {
      await mkdir(UPDATE_DIR, { recursive: true });
      await rm(EXTRACT_DIR, { recursive: true, force: true }).catch(() => {});

      const headers: Record<string, string> = {
        "user-agent": USER_AGENT,
      };
      if (process.env.GITHUB_TOKEN) {
        headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
      }

      const res = await fetch(picked.url, { headers });
      if (!res.ok || !res.body) {
        throw new Error(`Download failed with HTTP ${res.status}`);
      }

      const total = Number(res.headers.get("content-length")) || picked.size;
      state.totalBytes = total;

      const sink = Bun.file(archivePath).writer();
      const reader = res.body.getReader();
      let received = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          received += value.byteLength;
          await sink.write(value);
          state.downloadedBytes = received;
          state.percent = total > 0 ? Math.min(99, Math.round((received / total) * 100)) : 50;
        }
      }
      await sink.end();

      state.percent = 100;
      state.message = "Extracting installer package…";

      // Extract archive
      extractAppArchive(archivePath, EXTRACT_DIR);

      // Locate installer
      const installer = findInstallerFile(EXTRACT_DIR);
      if (!installer) {
        throw new Error("Installer executable was not found inside the update package.");
      }

      state.installerPath = installer;
      state.stage = "ready";
      state.message = `Compakta v${state.latestVersion} is ready to install.`;
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
 * Apply the downloaded update:
 * 1. Preserves bundled ImageMagick into persistent user storage.
 * 2. Launches the installer detached.
 * 3. Gracefully exits the current app process so the installer can replace files.
 */
export async function applyAppUpdate(): Promise<{ ok: boolean; message: string }> {
  if (state.stage !== "ready" || !state.installerPath || !existsSync(state.installerPath)) {
    throw new Error("No update is currently ready to apply.");
  }

  // Preserve ImageMagick before installer runs
  await preserveBundledMagick();

  const installer = state.installerPath;
  console.log("Launching installer:", installer);

  // Spawn detached so installer outlives this process
  const child = spawn(installer, [], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();

  // Gracefully exit the current process after a short delay
  setTimeout(() => {
    process.exit(0);
  }, 1000);

  return {
    ok: true,
    message: "Installer launched. Compakta will now restart.",
  };
}
