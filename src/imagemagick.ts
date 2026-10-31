/**
 * ImageMagick build management.
 *
 * The app looks for ImageMagick inside `imagemagick/`. This module asks the
 * official GitHub release feed for the newest build and, when the user agrees,
 * downloads it into that folder: a portable Q16 archive on Windows, and the
 * official x86_64 AppImage on Linux.
 *
 * Only the latest release from github.com/ImageMagick/ImageMagick is ever
 * fetched. No URL from the browser is trusted, and nothing outside
 * `imagemagick/` is written to.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { IS_LINUX, IS_WINDOWS, pathKey } from "./platform.ts";
import { findMagick, runMagickFile, type MagickInfo } from "./paths.ts";
import { compareVersions, isNewerVersion, parseVersion } from "./version.ts";
import { MAGICK_DIR, BUNDLED_MAGICK_DIR } from "./appdirs.ts";

export const IMAGEMAGICK_ROOT = MAGICK_DIR;

const RELEASE_API = "https://api.github.com/repos/ImageMagick/ImageMagick/releases/latest";
const RELEASES_PAGE = "https://github.com/ImageMagick/ImageMagick/releases";
const USER_AGENT = "compakta-imagemagick-updater";
const CACHE_MS = 10 * 60 * 1000;

export type PortableAsset = {
  name: string;
  size: number;
  url: string;
  /** GitHub's SHA-256 digest when the API supplies one. */
  digest: string | null;
};

export type AssetKind = "portable" | "appimage";

export type LatestRelease = {
  version: string;
  tag: string;
  publishedAt: string;
  pageUrl: string;
  asset: PortableAsset;
  kind: AssetKind;
};

export type InstallStage =
  | "idle"
  | "downloading"
  | "extracting"
  | "verifying"
  | "installing"
  | "done"
  | "error";

export type InstallProgress = {
  running: boolean;
  stage: InstallStage;
  message: string;
  percent: number;
  version: string | null;
  error: string | null;
};

export type InstalledMagick = {
  version: string;
  path: string;
  avifWritable: boolean;
  libheif: string | null;
};

export type UpdateStatus = {
  installed: InstalledMagick | null;
  installDir: string;
  online: boolean;
  latest: LatestRelease | null;
  /** True when a newer build exists, or when nothing is installed at all. */
  updateAvailable: boolean;
  /** Automatic installs are Windows and Linux x86_64 only. */
  supported: boolean;
  assetKind: AssetKind;
  /** True when the installed build lives under the app's imagemagick folder. */
  managed: boolean;
  checkedAt: number | null;
  error: string | null;
  install: InstallProgress;
};

export type InstallResult = {
  version: string;
  path: string;
  folder: string;
  bytes: number;
  replaced: boolean;
};

const port = (arch: string) => (arch === "arm64" ? "arm64" : "x64");

let cached: { at: number; release: LatestRelease } | null = null;

let progress: InstallProgress = {
  running: false,
  stage: "idle",
  message: "",
  percent: 0,
  version: null,
  error: null,
};

export function installProgress(): InstallProgress {
  return { ...progress };
}

/** True only for HTTPS URLs inside ImageMagick's own release downloads. */
export function isTrustedReleaseUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (
      u.protocol === "https:" &&
      u.hostname.toLowerCase() === "github.com" &&
      u.pathname.startsWith("/ImageMagick/ImageMagick/releases/download/")
    );
  } catch {
    return false;
  }
}

/**
 * Pick the portable Q16 archive for this CPU. The HDRI variant is deliberately
 * excluded: it ends in `portable-Q16-HDRI-x64.7z`, not the suffix we match.
 */
export function pickPortableAsset(
  assets: Array<{ name?: unknown; size?: unknown; browser_download_url?: unknown; digest?: unknown }>,
  arch = port(process.arch),
): PortableAsset | null {
  const suffix = `-portable-Q16-${arch}.7z`;
  for (const a of assets) {
    if (typeof a.name !== "string" || typeof a.browser_download_url !== "string") continue;
    if (!a.name.startsWith("ImageMagick-") || !a.name.endsWith(suffix)) continue;
    return {
      name: a.name,
      size: Number(a.size) || 0,
      url: a.browser_download_url,
      digest: typeof a.digest === "string" ? a.digest : null,
    };
  }
  return null;
}

/**
 * Official Linux AppImages are x86_64 only. The gcc build has the widest glibc
 * compatibility; clang is a fallback for releases that lack it.
 */
export function pickAppImageAsset(
  assets: Array<{ name?: unknown; size?: unknown; browser_download_url?: unknown; digest?: unknown }>,
  arch = process.arch,
): PortableAsset | null {
  if (arch !== "x64") return null;
  const candidates = assets.filter(
    (a): a is { name: string; size?: unknown; browser_download_url: string; digest?: unknown } =>
      typeof a.name === "string" &&
      typeof a.browser_download_url === "string" &&
      /^ImageMagick-.+-(gcc|clang)-x86_64\.AppImage$/.test(a.name),
  );
  const chosen =
    candidates.find((a) => /-gcc-x86_64\.AppImage$/.test(a.name)) ??
    candidates.find((a) => /-clang-x86_64\.AppImage$/.test(a.name));
  if (!chosen) return null;
  return {
    name: chosen.name,
    size: Number(chosen.size) || 0,
    url: chosen.browser_download_url,
    digest: typeof chosen.digest === "string" ? chosen.digest : null,
  };
}

function pickReleaseAsset(
  assets: Array<{ name?: unknown; size?: unknown; browser_download_url?: unknown; digest?: unknown }>,
): { asset: PortableAsset; kind: AssetKind } | null {
  if (IS_LINUX) {
    const asset = pickAppImageAsset(assets);
    return asset ? { asset, kind: "appimage" } : null;
  }
  const asset = pickPortableAsset(assets);
  return asset ? { asset, kind: "portable" } : null;
}

function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/\s+/g, " ").trim().slice(0, 300);
}

/** Ask GitHub for the latest release. Cached for 10 minutes unless forced. */
export async function fetchLatestRelease(force = false): Promise<LatestRelease> {
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.release;

  const headers: Record<string, string> = {
    "user-agent": USER_AGENT,
    accept: "application/vnd.github+json",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  let res: Response;
  try {
    res = await fetch(RELEASE_API, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new Error(`No internet connection to github.com (${errorText(err)}).`);
  }

  if (!res.ok) {
    throw new Error(`GitHub release check failed: HTTP ${res.status} ${res.statusText}.`);
  }

  let data: {
    tag_name?: unknown;
    html_url?: unknown;
    published_at?: unknown;
    assets?: unknown;
  };
  try {
    data = (await res.json()) as typeof data;
  } catch {
    throw new Error("GitHub returned an unreadable release response.");
  }

  const tag = String(data.tag_name ?? "").trim();
  const version = tag.replace(/^v/i, "");
  if (!parseVersion(version)) {
    throw new Error("GitHub returned a release without a recognisable version.");
  }

  const assets = Array.isArray(data.assets) ? data.assets : [];
  const picked = pickReleaseAsset(
    assets as Array<{ name?: unknown; size?: unknown; browser_download_url?: unknown; digest?: unknown }>,
  );
  if (!picked) {
    if (IS_LINUX) {
      if (process.arch !== "x64") {
        throw new Error(
          `No official ImageMagick AppImage for ${process.arch} Linux. ` +
            "Automatic installs support x86_64 only; use ImageMagick 7 from your distribution.",
        );
      }
      throw new Error(`Release ${version} has no official x86_64 AppImage asset.`);
    }
    throw new Error(`Release ${version} has no portable Q16 build for this CPU (${port(process.arch)}).`);
  }
  const { asset, kind } = picked;
  if (!isTrustedReleaseUrl(asset.url)) {
    throw new Error("Release asset URL is not on github.com; refusing to use it.");
  }

  const release: LatestRelease = {
    version,
    tag,
    publishedAt: String(data.published_at ?? ""),
    pageUrl: String(data.html_url ?? RELEASES_PAGE),
    asset,
    kind,
  };
  cached = { at: Date.now(), release };
  return release;
}

/** True when a binary lives inside the app's own imagemagick folder (user-managed or pre-bundled). */
export function isManagedInstall(p: string | null | undefined): boolean {
  if (!p) return false;
  const target = pathKey(path.resolve(p));
  const root = pathKey(path.resolve(IMAGEMAGICK_ROOT));
  if (target.startsWith(root + path.sep)) return true;
  if (BUNDLED_MAGICK_DIR) {
    const bundledRoot = pathKey(path.resolve(BUNDLED_MAGICK_DIR));
    if (target.startsWith(bundledRoot + path.sep)) return true;
  }
  return false;
}

/**
 * Compare the installed build against the newest GitHub release. Network
 * failures are reported rather than thrown, so the UI can keep working offline.
 */
export async function checkForUpdate(opts: {
  current: MagickInfo | null;
  force?: boolean;
}): Promise<UpdateStatus> {
  const installed: InstalledMagick | null = opts.current
    ? {
        version: opts.current.version,
        path: opts.current.path,
        avifWritable: opts.current.avifWritable,
        libheif: opts.current.libheif,
      }
    : null;
  const managed = isManagedInstall(installed?.path);
  const supported = IS_WINDOWS || (IS_LINUX && process.arch === "x64");

  if (!supported) {
    return {
      installed,
      installDir: IMAGEMAGICK_ROOT,
      online: false,
      latest: null,
      updateAvailable: false,
      supported: false,
      assetKind: IS_LINUX ? "appimage" : "portable",
      managed,
      checkedAt: null,
      error: installed
        ? null
        : IS_LINUX
          ? `Automatic AppImage installs are only available for x86_64 Linux. ` +
            "Install ImageMagick 7 with AVIF support from your distribution."
          : "Automatic ImageMagick installs are only supported on Windows and x86_64 Linux.",
      install: installProgress(),
    };
  }

  let latest: LatestRelease | null = null;
  let online = false;
  let error: string | null = null;

  try {
    latest = await fetchLatestRelease(Boolean(opts.force));
    online = true;
  } catch (err) {
    error = errorText(err);
    // A stale cached release is still useful: show it, but mark the check as
    // offline so the user knows it may not be current.
    if (cached) latest = cached.release;
  }

  let updateAvailable = false;
  if (latest) {
    if (!installed) {
      updateAvailable = true;
    } else if (IS_LINUX && !managed) {
      // Never shadow a working system build. The AppImage is only useful when
      // the system ImageMagick cannot encode AVIF.
      updateAvailable = !installed.avifWritable;
    } else {
      updateAvailable = isNewerVersion(latest.version, installed.version);
    }
  }

  return {
    installed,
    installDir: IMAGEMAGICK_ROOT,
    online,
    latest,
    updateAvailable,
    supported: true,
    assetKind: latest?.kind ?? (IS_LINUX ? "appimage" : "portable"),
    managed,
    checkedAt: online ? Date.now() : (cached?.at ?? null),
    error,
    install: installProgress(),
  };
}

/**
 * Download and install the latest portable build into
 * `imagemagick/ImageMagick-<version>-portable-Q16-<arch>/`.
 *
 * The archive is unpacked into a staging folder and its `magick.exe` is run and
 * checked for AVIF write support before anything replaces the current install.
 */
export async function installLatest(): Promise<InstallResult> {
  if (progress.running) throw new Error("An ImageMagick download is already in progress.");
  if (IS_LINUX) return installLatestAppImage();
  if (!IS_WINDOWS) {
    throw new Error("Automatic ImageMagick installs are only supported on Windows and x86_64 Linux.");
  }

  // Claim the lock before the first await so two simultaneous requests cannot
  // both start downloading.
  progress = {
    running: true,
    stage: "downloading",
    message: "Checking for the latest ImageMagick release…",
    percent: 0,
    version: null,
    error: null,
  };

  let release: LatestRelease;
  let arch: string;
  try {
    release = await fetchLatestRelease(true);
    arch = port(process.arch);
    if (!isTrustedReleaseUrl(release.asset.url)) {
      throw new Error("Refusing to download ImageMagick from an untrusted URL.");
    }
  } catch (err) {
    progress = {
      running: false,
      stage: "error",
      message: "ImageMagick install failed.",
      percent: 0,
      version: null,
      error: errorText(err),
    };
    throw err instanceof Error ? err : new Error(errorText(err));
  }

  const folderName = `ImageMagick-${release.version}-portable-Q16-${arch}`;
  const finalDir = path.join(IMAGEMAGICK_ROOT, folderName);
  const stamp = `${process.pid}-${Date.now()}`;
  const staging = path.join(IMAGEMAGICK_ROOT, `.staging-${release.version}-${stamp}`);
  const archive = path.join(IMAGEMAGICK_ROOT, `.download-${release.version}-${stamp}.7z`);

  // A copy the user unzipped by hand may already be the right version. Verify
  // it and use it rather than replacing a folder the app did not create.
  const existingExe = path.join(finalDir, "magick.exe");
  if (existsSync(existingExe)) {
    let usable = false;
    try {
      verifyStagedMagick(existingExe, release.version);
      usable = true;
    } catch {
      // Not a usable build. Continue and replace it after downloading.
    }
    if (usable) {
      try {
        await writeFile(path.join(IMAGEMAGICK_ROOT, "current.txt"), `${folderName}\n`, "utf8");
      } catch (err) {
        console.warn(`ImageMagick is installed, but current.txt was not written: ${errorText(err)}`);
      }
      progress = {
        running: false,
        stage: "done",
        message: `ImageMagick ${release.version} is already installed.`,
        percent: 100,
        version: release.version,
        error: null,
      };
      return {
        version: release.version,
        path: existingExe,
        folder: finalDir,
        bytes: 0,
        replaced: false,
      };
    }
  }

  progress = {
    running: true,
    stage: "downloading",
    message: `Downloading ImageMagick ${release.version}…`,
    percent: 0,
    version: release.version,
    error: null,
  };

  try {
    await mkdir(IMAGEMAGICK_ROOT, { recursive: true });
    await mkdir(staging, { recursive: true });

    const bytes = await downloadAsset(release.asset, archive, (percent) => {
      progress = {
        ...progress,
        stage: "downloading",
        percent,
        message: `Downloading ImageMagick ${release.version}… ${percent}%`,
      };
    });

    progress = { ...progress, stage: "extracting", message: "Extracting the portable build…", percent: 100 };
    extractArchive(archive, staging);

    const extractedRoot = await findExtractedRoot(staging);
    progress = { ...progress, stage: "verifying", message: "Verifying magick.exe and AVIF support…" };
    verifyStagedMagick(path.join(extractedRoot, "magick.exe"), release.version);

    progress = { ...progress, stage: "installing", message: `Installing into imagemagick\\${folderName}…` };
    const backup = await swapIntoPlace(extractedRoot, finalDir);

    try {
      await writeFile(path.join(finalDir, ".picmagik-managed"), `${release.version}\n`, "utf8");
      await writeFile(path.join(IMAGEMAGICK_ROOT, "current.txt"), `${folderName}\n`, "utf8");
    } catch (err) {
      // The build is usable even if the pointer file cannot be written; the
      // versioned folder is still discovered by name.
      if (backup) await rm(backup, { recursive: true, force: true }).catch(() => {});
      console.warn(`ImageMagick installed, but its pointer file was not written: ${errorText(err)}`);
    }

    if (backup) await rm(backup, { recursive: true, force: true }).catch(() => {});
    await pruneManagedVersions(folderName);

    progress = {
      running: false,
      stage: "done",
      message: `ImageMagick ${release.version} installed.`,
      percent: 100,
      version: release.version,
      error: null,
    };
    return {
      version: release.version,
      path: path.join(finalDir, "magick.exe"),
      folder: finalDir,
      bytes,
      replaced: Boolean(backup),
    };
  } catch (err) {
    const message = errorText(err);
    progress = {
      ...progress,
      running: false,
      stage: "error",
      message: "ImageMagick install failed.",
      error: message,
    };
    throw new Error(message);
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    await rm(archive, { force: true }).catch(() => {});
  }
}

/** State for the AppImage this app installed, kept beside current.txt. */
const APPIMAGE_MARKER = ".picmagik-appimage.json";

type ManagedAppImage = {
  kind?: string;
  version?: string;
  file?: string;
};

async function readManagedAppImage(): Promise<ManagedAppImage | null> {
  try {
    const raw = await readFile(path.join(IMAGEMAGICK_ROOT, APPIMAGE_MARKER), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as ManagedAppImage;
  } catch {
    return null;
  }
}

/**
 * Never hide a system ImageMagick that already works. The AppImage exists to
 * fill the AVIF gap; a distro build that can encode AVIF should stay in use.
 */
function assertNoWorkingSystemMagick(): void {
  if (process.env.COMPAKTA_FORCE_BUNDLE === "1" || process.env.PICMAGIK_FORCE_BUNDLE === "1") return;
  let current: MagickInfo | null = null;
  try {
    current = findMagick();
  } catch {
    return; // Nothing usable installed: the AppImage is the right choice.
  }
  if (!current || isManagedInstall(current.path)) return;
  if (current.avifWritable && (parseVersion(current.version)?.[0] ?? 0) >= 7) {
    throw new Error(
      `ImageMagick ${current.version} at ${current.path} already supports AVIF. ` +
        "The AppImage is only installed when the system build cannot encode AVIF.",
    );
  }
}

function sha256Digest(digest: string | null): string | null {
  if (!digest) return null;
  const match = /^sha256:([a-f0-9]{64})$/i.exec(digest.trim());
  return match ? match[1].toLowerCase() : null;
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/** Run the downloaded AppImage before trusting it. */
function verifyAppImage(file: string, expected: string): void {
  let versionOut: string;
  let formats: string;
  try {
    versionOut = runMagickFile(file, ["-version"], 60_000);
    formats = runMagickFile(file, ["-list", "format"], 120_000);
  } catch (err) {
    throw new Error(`The downloaded AppImage did not run (${errorText(err)}).`);
  }

  const reported = versionOut.split(/\r?\n/).find((l) => l.startsWith("Version:")) ?? versionOut;
  const parsed = parseVersion(reported);
  if (!parsed || compareVersions(parsed, expected) !== 0) {
    throw new Error(`Downloaded AppImage reports "${reported.trim()}", expected ${expected}.`);
  }

  const avifLine = formats.split(/\r?\n/).find((l) => /^\s*AVIF\s/.test(l));
  const mode = avifLine?.trim().split(/\s+/)[1] ?? "";
  if (!/w/.test(mode)) {
    throw new Error(`The downloaded AppImage cannot write AVIF (AVIF mode "${mode || "missing"}).`);
  }
}

async function writeAppImageState(file: string, version: string): Promise<void> {
  const marker: ManagedAppImage = { kind: "appimage", version, file };
  await writeFile(
    path.join(IMAGEMAGICK_ROOT, APPIMAGE_MARKER),
    `${JSON.stringify(marker)}\n`,
    "utf8",
  );
  await writeFile(path.join(IMAGEMAGICK_ROOT, "current.txt"), `${file}\n`, "utf8");
}

/** Delete only the previous AppImage this app recorded as its own. */
async function removePreviousAppImage(
  previous: ManagedAppImage | null,
  keepFile: string,
): Promise<void> {
  const file = previous?.file;
  if (previous?.kind !== "appimage" || typeof file !== "string" || file === keepFile) return;
  // Marker files are app-written, but never follow a path outside the folder.
  if (path.basename(file) !== file || !/\.appimage$/i.test(file)) return;
  await rm(path.join(IMAGEMAGICK_ROOT, file), { force: true }).catch(() => {});
}

/**
 * Install the official AppImage on Linux. Unlike the portable Windows build
 * there is nothing to extract: the asset itself becomes the executable, so the
 * install is a verified download followed by an atomic rename.
 */
async function installLatestAppImage(): Promise<InstallResult> {
  progress = {
    running: true,
    stage: "downloading",
    message: "Checking for the latest ImageMagick release…",
    percent: 0,
    version: null,
    error: null,
  };

  let temp: string | null = null;
  let backup: string | null = null;

  try {
    if (process.arch !== "x64") {
      throw new Error(
        `Automatic AppImage installs are only available for x86_64 Linux, not ${process.arch}.`,
      );
    }
    assertNoWorkingSystemMagick();

    const release = await fetchLatestRelease(true);
    if (release.kind !== "appimage") {
      throw new Error("The latest release did not contain an AppImage.");
    }
    if (!isTrustedReleaseUrl(release.asset.url)) {
      throw new Error("Refusing to download ImageMagick from an untrusted URL.");
    }

    const fileName = path.basename(release.asset.name);
    const nameVersion = parseVersion(fileName);
    if (
      fileName !== release.asset.name ||
      !/-x86_64\.AppImage$/i.test(fileName) ||
      !nameVersion ||
      compareVersions(nameVersion, release.version) !== 0
    ) {
      throw new Error(`Refusing an unexpected AppImage name: ${release.asset.name}`);
    }

    await mkdir(IMAGEMAGICK_ROOT, { recursive: true });
    const finalFile = path.join(IMAGEMAGICK_ROOT, fileName);
    const previous = await readManagedAppImage();

    // A previous run may already have downloaded this exact version.
    if (existsSync(finalFile)) {
      let usable = false;
      try {
        verifyAppImage(finalFile, release.version);
        usable = true;
      } catch {
        // Invalid or partial file: replace it after downloading.
      }
      if (usable) {
        try {
          await writeAppImageState(fileName, release.version);
        } catch (err) {
          console.warn(`AppImage is installed, but its state file was not written: ${errorText(err)}`);
        }
        await removePreviousAppImage(previous, fileName).catch(() => {});
        progress = {
          running: false,
          stage: "done",
          message: `ImageMagick ${release.version} is already installed.`,
          percent: 100,
          version: release.version,
          error: null,
        };
        return {
          version: release.version,
          path: finalFile,
          folder: IMAGEMAGICK_ROOT,
          bytes: 0,
          replaced: false,
        };
      }
    }

    progress = {
      running: true,
      stage: "downloading",
      message: `Downloading ImageMagick ${release.version}…`,
      percent: 0,
      version: release.version,
      error: null,
    };

    const stamp = `${process.pid}-${Date.now()}`;
    temp = path.join(IMAGEMAGICK_ROOT, `.download-${release.version}-${stamp}.AppImage`);

    const bytes = await downloadAsset(release.asset, temp, (percent) => {
      progress = {
        ...progress,
        stage: "downloading",
        percent,
        message: `Downloading ImageMagick ${release.version}… ${percent}%`,
      };
    });

    progress = { ...progress, stage: "verifying", message: "Checking the download…", percent: 100 };
    const expectedDigest = sha256Digest(release.asset.digest);
    if (release.asset.digest && !expectedDigest) {
      console.warn(`Ignoring unsupported GitHub digest format for ${fileName}.`);
    }
    if (expectedDigest) {
      const actual = await sha256File(temp);
      if (actual !== expectedDigest) {
        throw new Error("The downloaded AppImage failed its SHA-256 check.");
      }
    }

    await chmod(temp, 0o755);
    progress = { ...progress, stage: "verifying", message: "Verifying ImageMagick and AVIF support…" };
    verifyAppImage(temp, release.version);

    progress = { ...progress, stage: "installing", message: `Installing ${fileName}…` };
    if (existsSync(finalFile)) {
      backup = `${finalFile}.old-${stamp}`;
      await rename(finalFile, backup);
    }
    try {
      await rename(temp, finalFile);
      temp = null;
    } catch (err) {
      if (backup) {
        try {
          await rename(backup, finalFile);
          backup = null;
        } catch {
          // Leave the backup in place: it is the user's last working copy.
        }
      }
      throw err;
    }
    const replaced = Boolean(backup) || Boolean(previous?.file && previous.file !== fileName);

    try {
      await writeAppImageState(fileName, release.version);
    } catch (err) {
      // The binary works and will be found by name even without the pointer.
      console.warn(`AppImage installed, but its state file was not written: ${errorText(err)}`);
    }
    await removePreviousAppImage(previous, fileName).catch(() => {});

    if (backup) {
      await rm(backup, { force: true }).catch(() => {});
      backup = null;
    }

    progress = {
      running: false,
      stage: "done",
      message: `ImageMagick ${release.version} installed.`,
      percent: 100,
      version: release.version,
      error: null,
    };
    return {
      version: release.version,
      path: finalFile,
      folder: IMAGEMAGICK_ROOT,
      bytes,
      replaced,
    };
  } catch (err) {
    const message = errorText(err);
    progress = {
      ...progress,
      running: false,
      stage: "error",
      message: "ImageMagick install failed.",
      error: message,
    };
    throw new Error(message);
  } finally {
    // The old AppImage is removed only after the new one is in place. If a
    // failure left `backup` behind, keep it: it is the user's last working copy.
    if (temp) await rm(temp, { force: true }).catch(() => {});
  }
}

async function downloadAsset(
  asset: PortableAsset,
  dest: string,
  onPercent: (percent: number) => void,
): Promise<number> {
  let res: Response;
  try {
    res = await fetch(asset.url, {
      redirect: "follow",
      headers: { "user-agent": USER_AGENT, accept: "application/octet-stream" },
      // Large enough for a slow connection: the archive is ~12 MB.
      signal: AbortSignal.timeout(5 * 60_000),
    });
  } catch (err) {
    throw new Error(`Download failed (${errorText(err)}).`);
  }
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: HTTP ${res.status} ${res.statusText}.`);
  }

  const total = Number(res.headers.get("content-length")) || asset.size;
  const sink = Bun.file(dest).writer();
  const reader = res.body.getReader();
  let received = 0;
  let lastPercent = -1;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      await sink.write(value);
      received += value.byteLength;
      const percent = total > 0 ? Math.min(99, Math.floor((received / total) * 100)) : 0;
      if (percent !== lastPercent) {
        lastPercent = percent;
        onPercent(percent);
      }
    }
    await sink.end();
  } catch (err) {
    try { await sink.end(); } catch { /* already failing */ }
    throw new Error(`Download was interrupted (${errorText(err)}).`);
  }

  if (received < 1024) throw new Error("The downloaded archive was empty.");
  if (asset.size > 0 && received !== asset.size) {
    throw new Error(`Download was incomplete: got ${received} of ${asset.size} bytes.`);
  }
  onPercent(100);
  return received;
}

/** Windows ships bsdtar, which reads 7z. Fall back to 7-Zip if it is installed. */
function extractionCommands(archive: string, dest: string): Array<{ cmd: string; args: string[] }> {
  const out: Array<{ cmd: string; args: string[] }> = [];
  if (process.env.SEVEN_ZIP) {
    out.push({ cmd: process.env.SEVEN_ZIP, args: ["x", "-y", `-o${dest}`, archive] });
  }
  for (const base of [process.env["ProgramFiles"], process.env["ProgramFiles(x86)"]]) {
    if (base) {
      out.push({ cmd: path.join(base, "7-Zip", "7z.exe"), args: ["x", "-y", `-o${dest}`, archive] });
    }
  }
  out.push({ cmd: "7z.exe", args: ["x", "-y", `-o${dest}`, archive] });
  out.push({ cmd: "7za.exe", args: ["x", "-y", `-o${dest}`, archive] });

  if (process.platform === "win32") {
    const sys = process.env.SystemRoot ?? "C:\\Windows";
    out.push({
      cmd: path.join(sys, "System32", "tar.exe"),
      args: ["-xf", archive, "-C", dest],
    });
  } else {
    out.push({ cmd: "tar", args: ["-xf", archive, "-C", dest] });
  }
  return out;
}

function extractArchive(archive: string, dest: string): void {
  let lastError = "";
  for (const { cmd, args } of extractionCommands(archive, dest)) {
    try {
      execFileSync(cmd, args, {
        stdio: ["ignore", "ignore", "pipe"],
        timeout: 5 * 60_000,
        windowsHide: true,
      });
      return;
    } catch (err) {
      const e = err as { stderr?: Buffer | string; message?: string };
      lastError = String(e.stderr ?? e.message ?? "unknown extraction error").trim();
    }
  }
  throw new Error(
    `Could not extract the ImageMagick archive (${lastError.slice(0, 220)}). ` +
      "Windows 10+ includes tar.exe; installing 7-Zip also works.",
  );
}

async function findExtractedRoot(staging: string): Promise<string> {
  if (existsSync(path.join(staging, "magick.exe"))) return staging;
  let entries;
  try {
    entries = await readdir(staging, { withFileTypes: true });
  } catch {
    throw new Error("The download could not be read.");
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(staging, entry.name);
    if (existsSync(path.join(dir, "magick.exe"))) return dir;
  }
  throw new Error("The downloaded archive did not contain magick.exe.");
}

/** Run the staged binary before trusting it. A wrong download must not install. */
function verifyStagedMagick(exe: string, expected: string): void {
  let versionOut: string;
  let formats: string;
  try {
    versionOut = execFileSync(exe, ["-version"], {
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
    });
    formats = execFileSync(exe, ["-list", "format"], {
      encoding: "utf8",
      timeout: 60_000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (err) {
    throw new Error(`The downloaded magick.exe did not run (${errorText(err)}).`);
  }

  const reported = versionOut.split(/\r?\n/).find((l) => l.startsWith("Version:")) ?? versionOut;
  const parsed = parseVersion(reported);
  if (!parsed || compareVersions(parsed, expected) !== 0) {
    throw new Error(`Downloaded build reports "${reported.trim()}", expected ${expected}.`);
  }

  const avifLine = formats.split(/\r?\n/).find((l) => /^\s*AVIF\s/.test(l));
  const mode = avifLine?.trim().split(/\s+/)[1] ?? "";
  if (!/w/.test(mode)) {
    throw new Error(`The downloaded build cannot write AVIF (AVIF mode "${mode || "missing"}").`);
  }
}

/** Move the staged folder into place, keeping the old one until this succeeds. */
async function swapIntoPlace(sourceDir: string, finalDir: string): Promise<string | null> {
  let backup: string | null = null;
  if (existsSync(finalDir)) {
    backup = `${finalDir}.old-${Date.now()}`;
    await rename(finalDir, backup);
  }
  try {
    await rename(sourceDir, finalDir);
  } catch (err) {
    if (backup) await rename(backup, finalDir).catch(() => {});
    throw err;
  }
  return backup;
}

/** Delete older installs this app created. Hand-placed folders are left alone. */
async function pruneManagedVersions(keep: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(IMAGEMAGICK_ROOT, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === keep) continue;
    const full = path.join(IMAGEMAGICK_ROOT, entry.name);
    const ours = existsSync(path.join(full, ".picmagik-managed"));
    const staleBackup = /^ImageMagick-.+\.old-\d+$/.test(entry.name);
    if (!ours && !staleBackup) continue;
    await rm(full, { recursive: true, force: true }).catch(() => {});
  }
}
