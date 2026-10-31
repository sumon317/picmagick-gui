/**
 * Locating FFmpeg and FFprobe, probing encoder capabilities (CPU + GPU),
 * testing hardware encoder initialization, and managing automated downloads.
 */
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { BUNDLED_FFMPEG_DIR, FFMPEG_DIR } from "../appdirs.ts";
import type { FormatSupport } from "../paths.ts";
import { IS_LINUX, IS_WINDOWS } from "../platform.ts";
import { APP_VERSION } from "../version.ts";
import {
  VIDEO_OUTPUT_FORMATS,
  type VideoOutputFormat,
} from "./formats.ts";

export type FfmpegHwEncoders = {
  av1: string | null;
  hevc: string | null;
};

export type FfmpegInfo = {
  ffmpegPath: string;
  ffprobePath: string;
  version: string;
  managed: boolean;
  formats: Record<VideoOutputFormat, FormatSupport>;
  hwEncoders: FfmpegHwEncoders;
};

const FFMPEG_BIN = IS_WINDOWS ? "ffmpeg.exe" : "ffmpeg";
const FFPROBE_BIN = IS_WINDOWS ? "ffprobe.exe" : "ffprobe";

let cachedFfmpeg: FfmpegInfo | null = null;

const CAP_CACHE_FILE = path.join(FFMPEG_DIR, ".capabilities-cache.json");

export function isTrustedFfmpegUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    return (
      parsed.hostname === "github.com" &&
      parsed.pathname.startsWith("/BtbN/FFmpeg-Builds/releases/download/")
    );
  } catch {
    return false;
  }
}

function probeEncoders(ffmpegPath: string, version: string): {
  formats: Record<VideoOutputFormat, FormatSupport>;
  hwEncoders: FfmpegHwEncoders;
} {
  let cacheKey = `${ffmpegPath}:${version}`;
  try {
    if (path.isAbsolute(ffmpegPath) && existsSync(ffmpegPath)) {
      cacheKey += `:${statSync(ffmpegPath).mtimeMs}`;
    }
    if (existsSync(CAP_CACHE_FILE)) {
      const cached = JSON.parse(readFileSync(CAP_CACHE_FILE, "utf8"));
      if (cached?.key === cacheKey && cached.formats && cached.hwEncoders) {
        return { formats: cached.formats, hwEncoders: cached.hwEncoders };
      }
    }
  } catch {
    /* ignore cache read error */
  }

  const formats: Record<VideoOutputFormat, FormatSupport> = {
    av1: { mode: "ro", writable: false, detail: "libsvtav1 missing" },
    hevc: { mode: "ro", writable: false, detail: "libx265 missing" },
    av1_hw: { mode: "ro", writable: false, detail: "No AV1 hardware encoder found" },
    hevc_hw: { mode: "ro", writable: false, detail: "No HEVC hardware encoder found" },
    vp9: { mode: "ro", writable: false, detail: "libvpx-vp9 missing" },
  };

  const hwEncoders: FfmpegHwEncoders = { av1: null, hevc: null };

  let encoderOutput = "";
  try {
    encoderOutput = execFileSync(ffmpegPath, ["-hide_banner", "-encoders"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 6000,
    });
  } catch {
    return { formats, hwEncoders };
  }

  const has = (name: string) => new RegExp(`\\b${name}\\b`).test(encoderOutput);

  // 1. Software CPU Encoders
  if (has("libsvtav1")) {
    formats.av1 = { mode: "rw+", writable: true, detail: "libsvtav1 (10-bit)" };
  }
  if (has("libx265")) {
    formats.hevc = { mode: "rw+", writable: true, detail: "libx265" };
  }
  if (has("libvpx-vp9")) {
    formats.vp9 = { mode: "rw+", writable: true, detail: "libvpx-vp9" };
  }

  // 2. Hardware GPU Encoders (Test NVENC -> QSV -> AMF -> VAAPI)
  const av1Candidates = IS_WINDOWS
    ? ["av1_nvenc", "av1_qsv", "av1_amf"]
    : ["av1_nvenc", "av1_vaapi", "av1_qsv"];

  for (const candidate of av1Candidates) {
    if (has(candidate) && testHwEncoder(ffmpegPath, candidate)) {
      hwEncoders.av1 = candidate;
      formats.av1_hw = { mode: "rw+", writable: true, detail: candidate };
      break;
    }
  }

  const hevcCandidates = IS_WINDOWS
    ? ["hevc_nvenc", "hevc_qsv", "hevc_amf"]
    : ["hevc_nvenc", "hevc_vaapi", "hevc_qsv"];

  for (const candidate of hevcCandidates) {
    if (has(candidate) && testHwEncoder(ffmpegPath, candidate)) {
      hwEncoders.hevc = candidate;
      formats.hevc_hw = { mode: "rw+", writable: true, detail: candidate };
      break;
    }
  }

  try {
    mkdirSync(FFMPEG_DIR, { recursive: true });
    writeFileSync(CAP_CACHE_FILE, JSON.stringify({ key: cacheKey, formats, hwEncoders }), "utf8");
  } catch {
    /* ignore cache write error */
  }

  return { formats, hwEncoders };
}

/**
 * Runs a 1-frame dummy encode in memory to confirm the GPU driver accepts the encoder.
 */
function testHwEncoder(ffmpegPath: string, encoder: string): boolean {
  try {
    execFileSync(
      ffmpegPath,
      [
        "-hide_banner",
        "-nostdin",
        "-f", "lavfi",
        "-i", "color=c=black:s=64x64:d=0.04",
        "-c:v", encoder,
        "-f", "null",
        "-",
      ],
      { stdio: "ignore", windowsHide: true, timeout: 3500 },
    );
    return true;
  } catch {
    return false;
  }
}

function parseFfmpegVersion(ffmpegPath: string): string {
  try {
    const raw = execFileSync(ffmpegPath, ["-version"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 4000,
    });
    const match = /ffmpeg version\s+([^\s]+)/i.exec(raw);
    return match ? match[1] : "unknown";
  } catch {
    return "unknown";
  }
}

export function findFfmpeg(forceRefresh = false): FfmpegInfo {
  if (cachedFfmpeg && !forceRefresh) return cachedFfmpeg;

  const candidateDirs: { dir: string; managed: boolean }[] = [];

  if (BUNDLED_FFMPEG_DIR && existsSync(BUNDLED_FFMPEG_DIR)) {
    candidateDirs.push({ dir: BUNDLED_FFMPEG_DIR, managed: false });
  }

  if (existsSync(FFMPEG_DIR)) {
    candidateDirs.push({ dir: FFMPEG_DIR, managed: true });
    // Check possible bin/ subfolder
    const sub = path.join(FFMPEG_DIR, "bin");
    if (existsSync(sub)) candidateDirs.push({ dir: sub, managed: true });
    // Check unzipped nested folders
    try {
      for (const ent of readdirSync(FFMPEG_DIR, { withFileTypes: true })) {
        if (ent.isDirectory()) {
          const direct = path.join(FFMPEG_DIR, ent.name);
          candidateDirs.push({ dir: direct, managed: true });
          const nested = path.join(FFMPEG_DIR, ent.name, "bin");
          if (existsSync(nested)) candidateDirs.push({ dir: nested, managed: true });
        }
      }
    } catch {
      // ignore readdir error
    }
  }

  for (const { dir, managed } of candidateDirs) {
    const fPath = path.join(dir, FFMPEG_BIN);
    const pPath = path.join(dir, FFPROBE_BIN);
    if (existsSync(fPath) && existsSync(pPath)) {
      const version = parseFfmpegVersion(fPath);
      const { formats, hwEncoders } = probeEncoders(fPath, version);
      cachedFfmpeg = {
        ffmpegPath: fPath,
        ffprobePath: pPath,
        version,
        managed,
        formats,
        hwEncoders,
      };
      return cachedFfmpeg;
    }
  }

  // Check system PATH
  try {
    const version = parseFfmpegVersion(FFMPEG_BIN);
    if (version !== "unknown") {
      // Verify ffprobe also exists
      execFileSync(FFPROBE_BIN, ["-version"], { stdio: "ignore", windowsHide: true, timeout: 3000 });
      const { formats, hwEncoders } = probeEncoders(FFMPEG_BIN, version);
      cachedFfmpeg = {
        ffmpegPath: FFMPEG_BIN,
        ffprobePath: FFPROBE_BIN,
        version,
        managed: false,
        formats,
        hwEncoders,
      };
      return cachedFfmpeg;
    }
  } catch {
    // Not in PATH
  }

  throw new Error(
    "FFmpeg or FFprobe was not found on this system.\n" +
      `Install FFmpeg or download a managed build to ${FFMPEG_DIR}.`,
  );
}

export type FfmpegInstallProgress = {
  running: boolean;
  stage: "idle" | "downloading" | "extracting" | "done" | "error";
  percent: number;
  downloadedBytes: number;
  totalBytes: number;
  message: string;
  error?: string;
};

const installState: Omit<FfmpegInstallProgress, "running"> = {
  stage: "idle",
  percent: 0,
  downloadedBytes: 0,
  totalBytes: 0,
  message: "",
};

export function getFfmpegInstallProgress(): FfmpegInstallProgress {
  return {
    ...installState,
    running: installState.stage === "downloading" || installState.stage === "extracting",
  };
}

function getTarBinary(): string {
  if (IS_WINDOWS) {
    const sys = process.env.SystemRoot ?? "C:\\Windows";
    const sysTar = path.join(sys, "System32", "tar.exe");
    if (existsSync(sysTar)) return sysTar;
  }
  return "tar";
}

export async function installLatestFfmpeg(): Promise<{ ok: boolean; path: string }> {
  if (installState.stage === "downloading" || installState.stage === "extracting") {
    throw new Error("FFmpeg installation is already in progress.");
  }

  if (!IS_WINDOWS && process.platform !== "linux") {
    throw new Error(
      "Automated FFmpeg download is supported on Windows and Linux. On macOS, install FFmpeg via Homebrew ('brew install ffmpeg').",
    );
  }

  const url = IS_WINDOWS
    ? "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
    : "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz";

  if (!isTrustedFfmpegUrl(url)) {
    throw new Error("Untrusted download URL");
  }

  installState.stage = "downloading";
  installState.percent = 0;
  installState.downloadedBytes = 0;
  installState.totalBytes = 0;
  installState.message = "Downloading FFmpeg static release…";

  try {
    await mkdir(FFMPEG_DIR, { recursive: true });
    const archivePath = path.join(FFMPEG_DIR, path.basename(url));

    const res = await fetch(url, {
      headers: { "user-agent": `compakta/${APP_VERSION}` },
      redirect: "follow",
    });
    if (!res.ok || !res.body) {
      throw new Error(`Download failed with HTTP ${res.status}`);
    }

    const total = Number(res.headers.get("content-length")) || 0;
    installState.totalBytes = total;

    const sink = Bun.file(archivePath).writer();
    const reader = res.body.getReader();
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        received += value.byteLength;
        await sink.write(value);
        installState.downloadedBytes = received;
        installState.percent = total > 0 ? Math.min(99, Math.round((received / total) * 100)) : 50;
      }
    }
    await sink.end();

    installState.stage = "extracting";
    installState.percent = 100;
    installState.message = "Extracting FFmpeg package…";

    const tarCmd = getTarBinary();
    execFileSync(tarCmd, ["-xf", archivePath, "-C", FFMPEG_DIR], {
      windowsHide: true,
      timeout: 120_000,
    });

    if (!IS_WINDOWS) {
      try {
        for (const ent of readdirSync(FFMPEG_DIR, { withFileTypes: true, recursive: true })) {
          if (ent.isFile() && (ent.name === "ffmpeg" || ent.name === "ffprobe")) {
            const p = path.join(ent.parentPath || FFMPEG_DIR, ent.name);
            chmodSync(p, 0o755);
          }
        }
      } catch {
        // best effort
      }
    }

    rmSync(archivePath, { force: true });
    cachedFfmpeg = null;
    const info = findFfmpeg(true);

    installState.stage = "done";
    installState.message = `FFmpeg ${info.version} installed successfully.`;
    return { ok: true, path: info.ffmpegPath };
  } catch (err) {
    installState.stage = "error";
    installState.error = (err as Error).message;
    installState.message = `Installation failed: ${(err as Error).message}`;
    throw err;
  }
}
