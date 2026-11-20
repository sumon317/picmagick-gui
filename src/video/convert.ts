/**
 * The FFmpeg video conversion engine.
 *
 * Enforces three critical invariants:
 * 1. The source tree is read-only and never modified.
 * 2. In-flight encodes write to a temporary `.part.<ext>` path and are
 *    atomically renamed only on exit code 0 with non-zero bytes, preventing
 *    cancelled or killed encodes from leaving corrupt outputs behind.
 * 3. Live intra-file progress (`-progress pipe:1`) and live CPU core affinity
 *    throttling (`src/cpu.ts`) keep the UI responsive and the machine cool.
 */
import { spawn } from "node:child_process";
import { copyFile, mkdir, rename, rm, stat, utimes } from "node:fs/promises";
import path from "node:path";

import { runPool, type ConversionSummary, type FileResult } from "../convert.ts";
import { applyProcessCpuLimit } from "../cpu.ts";
import type { FfmpegInfo } from "./ffmpeg.ts";
import { buildVideoEncoderArgs, type VideoOutputFormat } from "./formats.ts";
import { probeVideo } from "./meta.ts";
import {
  videoOutputPathFor,
  type VideoDecision,
  type VideoPolicy,
} from "./policy.ts";

export type IntraFileProgress = {
  rel: string;
  percent: number;
  fps: number;
  speed: string;
  outBytes: number;
};

export type VideoRunOptions = {
  sourceRoot: string;
  effectiveDestination: string;
  ffmpeg: FfmpegInfo;
  policy: VideoPolicy;
  jobs: number;
  cpuLimit?: number;
  getLimit?: () => number;
  onWake?: (wake: () => void) => void;
  getCpuLimit?: () => number;
  onChildSpawn?: (pid: number) => void;
  onChildExit?: (pid: number) => void;
  overwrite: boolean;
  signal: AbortSignal;
  onStart: (rel: string, bytes: number) => void;
  onFileProgress?: (info: IntraFileProgress) => void;
  onResult: (r: FileResult) => void;
};

function partPathFor(finalOut: string): string {
  const ext = path.extname(finalOut);
  const base = finalOut.slice(0, finalOut.length - ext.length);
  return `${base}.part-${process.pid}${ext}`;
}

async function atomicCopyFile(
  src: string,
  dest: string,
  mtime: number,
  signal: AbortSignal,
): Promise<number> {
  await mkdir(path.dirname(dest), { recursive: true });
  if (signal.aborted) throw new Error("aborted");
  const part = partPathFor(dest);
  try {
    await copyFile(src, part);
    if (signal.aborted) throw new Error("aborted");
    const st = await stat(part);
    await rename(part, dest);
    const d = new Date(mtime);
    await utimes(dest, d, d).catch(() => {});
    return st.size;
  } finally {
    await rm(part, { force: true }).catch(() => {});
  }
}

async function overwriteOk(out: string, overwrite: boolean): Promise<boolean> {
  if (overwrite) return true;
  try {
    const st = await stat(out);
    return st.size === 0;
  } catch {
    return true;
  }
}

/**
 * True when the source video is already encoded in the target codec family and
 * meets resolution constraints, so re-encoding would waste hours for generation loss.
 */
function isAlreadyTargetCodec(
  srcVideoCodec: string | undefined,
  targetFormat: VideoOutputFormat,
): boolean {
  if (!srcVideoCodec) return false;
  if (targetFormat === "av1" || targetFormat === "av1_hw") {
    return srcVideoCodec === "av1";
  }
  if (targetFormat === "hevc" || targetFormat === "hevc_hw") {
    return srcVideoCodec === "hevc" || srcVideoCodec === "h265";
  }
  if (targetFormat === "vp9") {
    return srcVideoCodec === "vp9";
  }
  return false;
}

function runFfmpegWithProgress(
  ffmpegExe: string,
  args: string[],
  durationSec: number | undefined,
  rel: string,
  signal: AbortSignal,
  cpuLimit: number,
  onProgress?: (info: IntraFileProgress) => void,
  onChildSpawn?: (pid: number) => void,
  onChildExit?: (pid: number) => void,
): Promise<{ code: number; signal: NodeJS.Signals | null; stderr: string }> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve({ code: -1, signal: null, stderr: "aborted" });
      return;
    }
    const child = spawn(ffmpegExe, args, {
      windowsHide: true,
      detached: process.platform === "linux",
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (child.pid) {
      applyProcessCpuLimit(child.pid, cpuLimit);
      onChildSpawn?.(child.pid);
    }

    let stderr = "";
    child.stderr.on("data", (d) => {
      if (stderr.length < 8_000) stderr += String(d);
    });

    // Parse -progress pipe:1 key=value lines from stdout
    let stdoutBuf = "";
    let curFps = 0;
    let curSpeed = "";
    let curBytes = 0;
    let curTimeUs = 0;
    let lastEmitAt = 0;
    let sawUs = false;

    child.stdout.on("data", (chunk) => {
      stdoutBuf += String(chunk);
      const lines = stdoutBuf.split(/\r?\n/);
      stdoutBuf = lines.pop() ?? "";

      for (const line of lines) {
        const eq = line.indexOf("=");
        if (eq < 0) continue;
        const key = line.slice(0, eq).trim();
        const val = line.slice(eq + 1).trim();

        if (key === "fps") curFps = Number(val) || 0;
        else if (key === "speed") curSpeed = val;
        else if (key === "total_size") curBytes = Number(val) || 0;
        else if (key === "out_time_us") {
          sawUs = true;
          curTimeUs = Number(val) || 0;
        } else if (key === "out_time_ms" && !sawUs) {
          curTimeUs = Number(val) || 0;
        } else if (key === "progress" && onProgress) {
          const now = Date.now();
          if (now - lastEmitAt >= 350 || val === "end") {
            lastEmitAt = now;
            const totalUs = (durationSec ?? 0) * 1_000_000;
            const pct =
              totalUs > 0
                ? Math.max(0, Math.min(99, Math.round((curTimeUs / totalUs) * 100)))
                : 0;
            onProgress({
              rel,
              percent: val === "end" ? 100 : pct,
              fps: curFps,
              speed: curSpeed,
              outBytes: curBytes,
            });
          }
        }
      }
    });

    const onAbort = () => {
      if (process.platform === "linux" && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
          // not a group leader
        }
      }
      try {
        child.kill();
      } catch {
        /* already exited */
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });

    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
      if (child.pid) onChildExit?.(child.pid);
    };

    child.on("error", (err) => {
      cleanup();
      resolve({ code: -1, signal: null, stderr: String(err.message ?? err) });
    });

    child.on("close", (code, exitSignal) => {
      cleanup();
      resolve({ code: code ?? -1, signal: exitSignal, stderr });
    });
  });
}

async function processOneVideo(
  d: VideoDecision,
  o: VideoRunOptions,
): Promise<FileResult> {
  const started = Date.now();
  const src = d.file.abs;
  o.onStart(d.file.rel, d.file.size);

  const base: FileResult = {
    rel: d.file.rel,
    src,
    out: null,
    status: "failed",
    seconds: 0,
    inBytes: d.file.size,
    outBytes: 0,
  };

  if (o.signal.aborted) {
    return { ...base, status: "cancelled", seconds: 0 };
  }

  let partOut: string | null = null;

  try {
    // 1. Explicit copy verdict
    if (d.verdict === "copy") {
      const out = videoOutputPathFor(d, o.sourceRoot, o.effectiveDestination, o.policy);
      if (!(await overwriteOk(out, o.overwrite))) {
        return { ...base, out, status: "skipped", seconds: (Date.now() - started) / 1000 };
      }
      const copiedBytes = await atomicCopyFile(src, out, d.file.mtime, o.signal);
      return {
        ...base,
        out,
        status: "copied",
        seconds: (Date.now() - started) / 1000,
        outBytes: copiedBytes,
      };
    }

    // 2. Probe source video for duration, audio codec, framerate, and codec check
    const facts = await probeVideo(
      o.ffmpeg.ffprobePath,
      src,
      d.file.mtime,
      d.file.size,
      o.signal,
    );

    if (o.signal.aborted) {
      return { ...base, status: "cancelled", seconds: (Date.now() - started) / 1000 };
    }

    const finalOut = videoOutputPathFor(d, o.sourceRoot, o.effectiveDestination, o.policy);
    if (!(await overwriteOk(finalOut, o.overwrite))) {
      return {
        ...base,
        out: finalOut,
        status: "skipped",
        seconds: (Date.now() - started) / 1000,
      };
    }

    // Smart Skip/Copy: if already encoded in target codec and resolution is within cap
    if (
      o.policy.skipAlreadyEfficient &&
      facts.ok &&
      isAlreadyTargetCodec(facts.videoCodec, o.policy.outputFormat)
    ) {
      const resOk =
        o.policy.maxResolution === 0 ||
        (facts.width &&
          facts.height &&
          Math.min(facts.width, facts.height) <= o.policy.maxResolution);
      const fpsOk =
        o.policy.maxFps === 0 ||
        !facts.fps ||
        facts.fps <= o.policy.maxFps + 0.5;
      const audioOk = o.policy.audioMode === "auto" || o.policy.audioMode === "copy";
      if (resOk && fpsOk && audioOk && o.policy.quality >= 52) {
        const copyDecision: VideoDecision = { ...d, verdict: "copy", reason: "already-efficient" };
        const copyOut = videoOutputPathFor(
          copyDecision,
          o.sourceRoot,
          o.effectiveDestination,
          o.policy,
        );
        if (!(await overwriteOk(copyOut, o.overwrite))) {
          return { ...base, out: copyOut, status: "skipped", seconds: (Date.now() - started) / 1000 };
        }
        const copiedBytes = await atomicCopyFile(src, copyOut, d.file.mtime, o.signal);
        return {
          ...base,
          out: copyOut,
          status: "copied",
          seconds: (Date.now() - started) / 1000,
          outBytes: copiedBytes,
        };
      }
    }

    // 3. Encode to atomic .part.<ext> file
    await mkdir(path.dirname(finalOut), { recursive: true });
    partOut = partPathFor(finalOut);
    await rm(partOut, { force: true }).catch(() => {});

    const hwEncoderName =
      o.policy.outputFormat === "av1_hw"
        ? o.ffmpeg.hwEncoders.av1
        : o.policy.outputFormat === "hevc_hw"
          ? o.ffmpeg.hwEncoders.hevc
          : null;

    const args = buildVideoEncoderArgs({
      src,
      out: partOut,
      format: o.policy.outputFormat,
      container: o.policy.container,
      quality: o.policy.quality,
      speed: o.policy.speed,
      maxResolution: o.policy.maxResolution,
      maxFps: o.policy.maxFps,
      audioMode: o.policy.audioMode,
      sourceAudioCodec: facts.audioCodec,
      sourceFps: facts.fps,
      isHdr: facts.isHdr,
      colorTransfer: facts.colorTransfer,
      tenBit: o.policy.tenBit,
      filmGrain: o.policy.filmGrain,
      customParams: o.policy.customParams,
      hwEncoderName,
      progressPipe: true,
    });

    const cpuLimit = o.getCpuLimit ? o.getCpuLimit() : (o.cpuLimit ?? 70);
    const { code, signal, stderr } = await runFfmpegWithProgress(
      o.ffmpeg.ffmpegPath,
      args,
      facts.durationSec,
      d.file.rel,
      o.signal,
      cpuLimit,
      o.onFileProgress,
      o.onChildSpawn,
      o.onChildExit,
    );

    if (o.signal.aborted) {
      await rm(partOut, { force: true }).catch(() => {});
      return { ...base, status: "cancelled", seconds: (Date.now() - started) / 1000 };
    }

    let finalCode = code;
    let finalSignal = signal;
    let finalStderr = stderr;

    const isHw = o.policy.outputFormat === "av1_hw" || o.policy.outputFormat === "hevc_hw";
    if (finalCode !== 0 && isHw && !o.signal.aborted) {
      // GPU decode error fallback: retry once using CPU decode to bypass hardware decoder faults
      await rm(partOut, { force: true }).catch(() => {});
      const fallbackArgs = buildVideoEncoderArgs({
        src,
        out: partOut,
        format: o.policy.outputFormat,
        container: o.policy.container,
        quality: o.policy.quality,
        speed: o.policy.speed,
        maxResolution: o.policy.maxResolution,
        maxFps: o.policy.maxFps,
        audioMode: o.policy.audioMode,
        sourceAudioCodec: facts.audioCodec,
        sourceFps: facts.fps,
        isHdr: facts.isHdr,
        colorTransfer: facts.colorTransfer,
        tenBit: o.policy.tenBit,
        filmGrain: o.policy.filmGrain,
        customParams: o.policy.customParams,
        hwEncoderName,
        progressPipe: true,
        skipHwDecode: true,
      });

      const fallbackRun = await runFfmpegWithProgress(
        o.ffmpeg.ffmpegPath,
        fallbackArgs,
        facts.durationSec,
        d.file.rel,
        o.signal,
        cpuLimit,
        o.onFileProgress,
        o.onChildSpawn,
        o.onChildExit,
      );

      finalCode = fallbackRun.code;
      finalSignal = fallbackRun.signal;
      finalStderr = fallbackRun.stderr;
    }

    if (finalCode !== 0) {
      await rm(partOut, { force: true }).catch(() => {});
      const detail = finalStderr.trim().split(/\r?\n/).slice(-3).join(" ").slice(0, 220);
      const errText =
        detail ||
        (finalSignal
          ? `ffmpeg was killed by ${finalSignal}`
          : `ffmpeg exited with code ${finalCode}`);
      return {
        ...base,
        status: "failed",
        seconds: (Date.now() - started) / 1000,
        error: errText,
      };
    }

    const st = await stat(partOut);
    if (st.size === 0) {
      await rm(partOut, { force: true }).catch(() => {});
      return {
        ...base,
        status: "failed",
        seconds: (Date.now() - started) / 1000,
        error: "ffmpeg wrote an empty output file",
      };
    }

    // If skipAlreadyEfficient is enabled and the re-encoded output ended up larger
    // than the source file, copy the original instead so we never inflate storage.
    if (o.policy.skipAlreadyEfficient && st.size >= d.file.size) {
      await rm(partOut, { force: true }).catch(() => {});
      partOut = null;
      const copyDecision: VideoDecision = { ...d, verdict: "copy", reason: "already-efficient" };
      const copyOut = videoOutputPathFor(
        copyDecision,
        o.sourceRoot,
        o.effectiveDestination,
        o.policy,
      );
      if (!(await overwriteOk(copyOut, o.overwrite))) {
        return {
          ...base,
          out: copyOut,
          status: "skipped",
          seconds: (Date.now() - started) / 1000,
        };
      }
      const copiedBytes = await atomicCopyFile(src, copyOut, d.file.mtime, o.signal);
      return {
        ...base,
        out: copyOut,
        status: "copied",
        seconds: (Date.now() - started) / 1000,
        outBytes: copiedBytes,
      };
    }

    await rename(partOut, finalOut);
    partOut = null;
    const finalMtime = new Date(d.file.mtime);
    await utimes(finalOut, finalMtime, finalMtime).catch(() => {});

    return {
      ...base,
      out: finalOut,
      status: "converted",
      seconds: (Date.now() - started) / 1000,
      outBytes: st.size,
    };
  } catch (err) {
    if (o.signal.aborted) {
      return { ...base, status: "cancelled", seconds: (Date.now() - started) / 1000 };
    }
    return {
      ...base,
      status: "failed",
      seconds: (Date.now() - started) / 1000,
      error: (err as Error).message,
    };
  } finally {
    if (partOut) {
      await rm(partOut, { force: true }).catch(() => {});
    }
  }
}

export async function runVideoConversion(
  decisions: VideoDecision[],
  options: VideoRunOptions,
  shouldStop?: () => boolean,
): Promise<ConversionSummary> {
  const results: FileResult[] = [];
  const began = Date.now();
  await mkdir(options.effectiveDestination, { recursive: true });

  await runPool(
    decisions,
    options.signal,
    async (d) => {
      const r = await processOneVideo(d, options);
      results.push(r);
      options.onResult(r);
    },
    shouldStop,
    options.getLimit ?? (() => 1),
    options.onWake,
  );

  return {
    results,
    ok: results.filter((r) => r.status === "converted").length,
    copied: results.filter((r) => r.status === "copied").length,
    failed: results.filter((r) => r.status === "failed").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    partial: 0,
    bytes: results.reduce((a, r) => a + r.outBytes, 0),
    seconds: (Date.now() - began) / 1000,
    stoppedEarly: (shouldStop?.() ?? false) || options.signal.aborted,
  };
}
