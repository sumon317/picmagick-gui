/**
 * Locating ImageMagick, probing its capabilities, and enforcing the safety
 * invariants that keep this tool from ever touching the originals.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, type Dirent } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { homedir } from "node:os";
import { IS_LINUX, IS_WINDOWS, MAGICK_BIN, pathKey } from "./platform.ts";
import { compareVersions, parseVersion } from "./version.ts";
import { OUTPUT_FORMATS, type OutputFormat } from "./formats.ts";
import { MAGICK_DIR, BUNDLED_MAGICK_DIR } from "./appdirs.ts";

export const CONVERT_EXTS = [
  "jpg", "jpeg", "jpe", "jfif", "heic", "heif", "png", "bmp", "tif", "tiff", "webp", "gif",
] as const;

export const RAW_EXTS = [
  "arw", "dng", "cr2", "cr3", "nef", "orf", "rw2", "raf", "pef", "srw", "raw",
] as const;

/** Deliberately out of scope: this tool handles still images only. */
export const VIDEO_EXTS = [
  "mp4", "mov", "m4v", "avi", "mkv", "3gp", "mts", "m2ts", "webm", "mpg", "mpeg", "wmv", "flv", "ogv",
] as const;

export const extOf = (p: string) => path.extname(p).replace(/^\./, "").toLowerCase();

export type FormatSupport = {
  /** Raw mode string from `magick -list format`, e.g. "rw+". */
  mode: string;
  writable: boolean;
  /** Delegate/version text in parentheses, e.g. "libjxl 0.12.0". */
  detail: string | null;
};

export type MagickInfo = {
  path: string;
  version: string;
  /** Capability for every output format this app can write. */
  formats: Record<OutputFormat, FormatSupport>;
  /** Compatibility aliases for the AVIF-specific code paths. */
  avifMode: string;
  avifWritable: boolean;
  libheif: string | null;
};

/**
 * Parse the relevant rows from `magick -list format`.
 *
 * The trailing `*` is optional and common: the bundled build prints
 * `JXL* rw+`, `WEBP* rw+`, `JP2* rw-`, `JPEG* rw-`, and `PNG* rw-`, while
 * `AVIF` and `HEIC` have no star. `rw+` and `rw-` are both writable; `+`
 * additionally supports multiple frames/adjoin.
 */
export function parseFormatSupport(text: string): Record<OutputFormat, FormatSupport> {
  const out = {} as Record<OutputFormat, FormatSupport>;
  const names: Record<OutputFormat, string> = {
    jxl: "JXL",
    avif: "AVIF",
    webp: "WEBP",
    heic: "HEIC",
    jp2: "JP2",
    jpeg: "JPEG",
    png: "PNG",
  };

  for (const id of OUTPUT_FORMATS) {
    const name = names[id];
    const line = text
      .split(/\r?\n/)
      .find((l) => new RegExp(`^\\s*${name}\\*?\\s+`).test(l))
      ?.trim();

    const tokens = line?.split(/\s+/) ?? [];
    // Static builds print "AVIF* rw+ ..."; modular Linux builds include a
    // middle Module column: "AVIF  HEIC  rw+ ...". Pick whichever token is the
    // 3-char rw+/- mode flag.
    const modeRe = /^[r-][w-][+-]$/;
    const mode =
      (tokens[1] && modeRe.test(tokens[1]) ? tokens[1] : null) ??
      (tokens[2] && modeRe.test(tokens[2]) ? tokens[2] : null) ??
      tokens[1] ??
      "";
    // Some rows have more than one parenthetical group. The delegate/version
    // is the last one: "JPEG XL (ISO/IEC 18181) (libjxl 0.12.0)".
    const details = [...(line ?? "").matchAll(/\(([^)]+)\)/g)];
    const detail = details.at(-1)?.[1] ?? null;
    out[id] = { mode, writable: /w/.test(mode), detail };
  }

  return out;
}

/** Where the app keeps (or downloads) its own portable ImageMagick. */
export const LOCAL_MAGICK_ROOT = MAGICK_DIR;

function readTextSafe(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export const isAppImage = (p: string): boolean => /\.appimage$/i.test(p);

/**
 * Run a magick binary and retry AppImages with the extract-and-run fallback.
 *
 * AppImages need FUSE, which minimal containers and some distros lack. Setting
 * the fallback in `process.env` after the first successful retry means every
 * later child inherits it; no other call site needs to know about AppImages.
 */
export function runMagickFile(
  exe: string,
  args: string[],
  timeout = 30_000,
  maxBuffer = 8 * 1024 * 1024,
): string {
  const options = { encoding: "utf8" as const, timeout, windowsHide: true, maxBuffer };
  try {
    return execFileSync(exe, args, options);
  } catch (err) {
    if (!isAppImage(exe) || process.env.APPIMAGE_EXTRACT_AND_RUN === "1") throw err;
    const out = execFileSync(exe, args, {
      ...options,
      env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: "1" },
    });
    process.env.APPIMAGE_EXTRACT_AND_RUN = "1";
    return out;
  }
}

/** AppImages in `imagemagick/`, newest version first. */
function appImageCandidates(root: string): string[] {
  if (!IS_LINUX) return [];
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && isAppImage(e.name))
    .map((e) => path.join(root, e.name))
    .sort((a, b) => {
      const an = path.basename(a);
      const bn = path.basename(b);
      return compareVersions(bn, an) || bn.localeCompare(an);
    });
}

/**
 * Candidates inside `imagemagick/`, best first:
 *   1. the folder named by current.txt (written by the updater),
 *   2. the folder root itself, for anyone who unzipped the archive contents,
 *   3. every versioned subfolder, newest version first.
 *
 * The old behaviour searched beside the project. Keeping this first means an
 * in-project copy wins even if an older portable build sits next to it.
 */
function projectMagickCandidates(root: string = LOCAL_MAGICK_ROOT): string[] {
  const out: string[] = [];

  const pointer = readTextSafe(path.join(root, "current.txt"))?.trim();
  if (pointer) {
    const target = path.resolve(root, pointer.replace(/^["']|["']$/g, ""));
    // current.txt is app-written, but never let it point outside the folder.
    if (pathKey(target).startsWith(pathKey(root) + path.sep)) {
      out.push(IS_LINUX && isAppImage(target) ? target : path.join(target, MAGICK_BIN));
    }
  }

  out.push(path.join(root, MAGICK_BIN));
  out.push(...appImageCandidates(root));

  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    entries = [];
  }

  const nested = entries
    .filter((e) => e.isDirectory() && existsSync(path.join(root, e.name, MAGICK_BIN)))
    .map((e) => path.join(root, e.name, MAGICK_BIN))
    .sort((a, b) => {
      const an = path.basename(path.dirname(a));
      const bn = path.basename(path.dirname(b));
      return compareVersions(bn, an) || bn.localeCompare(an);
    });

  out.push(...nested);
  return out;
}

function candidateMagickPaths(): string[] {
  const here = import.meta.dir;
  const out: string[] = [];

  // 1. The portable build shipped in this project's own imagemagick folder (or user-managed in DATA_ROOT).
  out.push(...projectMagickCandidates(LOCAL_MAGICK_ROOT));

  // 2. Pre-bundled build shipped inside the packaged app, if present.
  if (BUNDLED_MAGICK_DIR && pathKey(BUNDLED_MAGICK_DIR) !== pathKey(LOCAL_MAGICK_ROOT)) {
    out.push(...projectMagickCandidates(BUNDLED_MAGICK_DIR));
  }

  if (IS_WINDOWS) {
    // 2. A copy dropped beside this project (the original layout).
    for (const rel of [
      `../ImageMagick-7.1.2-33-portable-Q16-x64/${MAGICK_BIN}`,
      `../${MAGICK_BIN}`,
      `./${MAGICK_BIN}`,
    ]) {
      out.push(path.resolve(here, rel));
    }
    // 3. Anywhere up the tree, so moving the project folder does not break it.
    let dir = here;
    for (let i = 0; i < 4; i++) {
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
      for (const name of readdirSafe(dir)) {
        if (/^ImageMagick.*portable.*x64$/i.test(name)) {
          out.push(path.join(dir, name, MAGICK_BIN));
        }
      }
    }
    // 4. Standard install locations (newest version first).
    const pf = process.env["ProgramFiles"];
    const pfx = process.env["ProgramFiles(x86)"];
    const installedDirs: string[] = [];
    for (const root of [pf, pfx]) {
      if (!root) continue;
      for (const name of readdirSafe(root)) {
        if (/^ImageMagick-7\./i.test(name)) installedDirs.push(path.join(root, name, MAGICK_BIN));
      }
    }
    installedDirs.sort((a, b) => {
      const an = path.basename(path.dirname(a));
      const bn = path.basename(path.dirname(b));
      return compareVersions(bn, an) || bn.localeCompare(an);
    });
    out.push(...installedDirs);
    // 5. Whatever is on PATH.
    out.push(MAGICK_BIN);
    out.push("magick");
  } else if (IS_LINUX) {
    // 2. Per-user and standard distro locations.
    for (const dir of [
      path.join(homedir(), ".local", "bin"),
      "/usr/local/bin",
      "/usr/bin",
      "/snap/bin",
      "/opt/ImageMagick/bin",
    ]) {
      out.push(path.join(dir, MAGICK_BIN));
    }
    // 3. Whatever is on PATH.
    out.push(MAGICK_BIN);
  } else {
    // macOS: Homebrew (Apple Silicon / Intel) and MacPorts install locations,
    // then whatever is on PATH.
    for (const dir of [
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/opt/local/bin",
    ]) {
      out.push(path.join(dir, MAGICK_BIN));
    }
    out.push(MAGICK_BIN);
    out.push("magick");
  }

  return [...new Set(out)];
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir) as string[];
  } catch {
    return [];
  }
}

let magickCache: { at: number; info: MagickInfo } | null = null;
const MAGICK_CACHE_TTL_MS = 30_000;

export function invalidateMagickCache(): void {
  magickCache = null;
}

export function findMagick(force = false): MagickInfo {
  if (!force && magickCache && Date.now() - magickCache.at < MAGICK_CACHE_TTL_MS) {
    return magickCache.info;
  }
  const tried = candidateMagickPaths();
  const rejected: string[] = [];

  for (const candidate of tried) {
    const isBare = !path.isAbsolute(candidate);
    if (!isBare && !existsSync(candidate)) continue;

    try {
      const version = runMagickFile(candidate, ["-version"], 20_000);
      const line = version.split(/\r?\n/).find((l) => l.startsWith("Version:"))?.trim() ?? "";
      const parsed = parseVersion(line);
      // Windows previously accepted whatever it found; keep that behaviour.
      // Linux is ImageMagick 7 only, because AVIF encoding needs it.
      if (IS_LINUX && (!parsed || parsed[0] < 7)) {
        rejected.push(`${candidate} (${parsed ? `ImageMagick ${parsed[0]}` : "unknown version"})`);
        continue;
      }

      const formats = runMagickFile(candidate, ["-list", "format"], 30_000);
      const support = parseFormatSupport(formats);
      const avif = support.avif;

      const info: MagickInfo = {
        path: candidate,
        // Keep the build and architecture, but not the redundant "ImageMagick"
        // prefix. The UI already labels the row.
        version: line.replace(/^Version:\s*/, "").replace(/^ImageMagick\s+/, ""),
        formats: support,
        avifMode: avif.mode,
        avifWritable: avif.writable,
        libheif: avif.detail,
      };
      magickCache = { at: Date.now(), info };
      return info;
    } catch (err) {
      if (isBare) continue; // not on PATH, keep looking
      continue;
    }
  }

  const older = rejected.length
    ? `\n\nIgnored builds without ImageMagick 7:\n  ${rejected.join("\n  ")}`
    : "";
  if (!IS_WINDOWS) {
    throw new Error(
      "Could not find ImageMagick 7 (magick).\n\n" +
        "Install ImageMagick 7 with AVIF support from your distribution,\n" +
        "or use the Health panel to download the official AppImage.\n" +
        "Looked in:\n  " + tried.join("\n  ") + older,
    );
  }
  throw new Error(
    `Could not find ${MAGICK_BIN}.\n\n` +
      `Put a portable ImageMagick folder in ${LOCAL_MAGICK_ROOT},\n` +
      "or use the Health panel to download one. A normal install also works.\n" +
      "Looked in:\n  " + tried.join("\n  "),
  );
}

/**
 * Resolve symlinks on the deepest existing ancestor of `p`, re-attaching any
 * not-yet-created trailing path segments. Prevents symlink/junction bypasses
 * when checking destination containment.
 */
function resolveRealPath(p: string): string {
  const abs = path.resolve(p);
  const tail: string[] = [];
  let cur = abs;
  while (true) {
    try {
      const real = realpathSync(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * Hard invariant #2: the output tree must never live inside the source tree,
 * or the mirror would recurse into its own output forever.
 */
export function assertDestinationSafe(source: string, destination: string): void {
  if (!destination || !path.isAbsolute(destination)) {
    throw new Error(`Destination must be an absolute path, got: ${destination}`);
  }
  const pairs: Array<[string, string]> = [
    [pathKey(path.resolve(source)), pathKey(path.resolve(destination))],
    [pathKey(resolveRealPath(source)), pathKey(resolveRealPath(destination))],
  ];

  for (const [src, dst] of pairs) {
    if (dst === src) {
      throw new Error("Destination cannot be the source folder.");
    }
    const prefix = src.endsWith(path.sep) ? src : src + path.sep;
    if (dst.startsWith(prefix)) {
      throw new Error(
        `Destination "${destination}" is inside the source folder "${source}".\n` +
          `Choose a sibling folder instead, e.g. ${IS_WINDOWS ? "D:\\Photos-avif" : `${source}-avif`}`,
      );
    }
  }
}

/**
 * Free bytes on the volume holding `p`.
 *
 * Uses statfs, which is a syscall. The previous PowerShell probe took ~3.6
 * seconds per call on a typical Windows machine, and this runs on every preview and every
 * status request, so it was the entire perceived startup delay.
 */
export async function freeSpace(p: string): Promise<number | null> {
  const { statfs } = await import("node:fs/promises");
  let target = path.resolve(p);
  while (true) {
    try {
      const s = await statfs(target);
      return Number(s.bsize) * Number(s.bavail);
    } catch {
      const parent = path.dirname(target);
      if (parent === target) break;
      target = parent;
    }
  }

  if (!IS_WINDOWS) return null;

  const root = path.parse(path.resolve(p)).root;
  const drive = root.replace(/[:\\]/g, "");
  if (!/^[A-Za-z]$/.test(drive)) return null;

  return new Promise<number | null>((resolve) => {
    const ps = `(Get-PSDrive -Name '${drive}').Free`;
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", ps],
      { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    );
    let out = "";
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* gone */ }
      resolve(null);
    }, 20_000);
    child.stdout.on("data", (d) => { if (out.length < 256) out += String(d); });
    child.on("error", () => { clearTimeout(timer); resolve(null); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(null);
      const n = Number(out.trim());
      resolve(Number.isFinite(n) ? n : null);
    });
  });
}

export async function ensureDir(p: string): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(p, { recursive: true });
}

export async function dirExists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}