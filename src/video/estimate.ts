/**
 * Fast slice-based video sample estimation.
 *
 * Encoding 120 full videos just to estimate output size would take hours.
 * Instead, this selects a stratified sample of videos (default 5) and encodes
 * a 3-second midpoint slice from each using the user's exact recipe (codec,
 * CRF, preset, resolution cap, framerate cap, film grain). It then scales the
 * measured slice bitrate and encode speed across the full library duration.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { applyProcessCpuLimit } from "../cpu.ts";
import { stratifiedSample, type Estimate } from "../estimate.ts";
import type { OutputFormat } from "../formats.ts";
import type { FfmpegInfo } from "./ffmpeg.ts";
import { buildVideoEncoderArgs, VIDEO_FORMAT_SPECS } from "./formats.ts";
import { probeVideo } from "./meta.ts";
import type { VideoDecision, VideoPolicy } from "./policy.ts";

function runFfmpegSlice(exe: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const c = spawn(exe, args, { windowsHide: true, stdio: "ignore" });
    if (c.pid) applyProcessCpuLimit(c.pid, 70);
    c.on("error", () => resolve(-1));
    c.on("close", (code) => resolve(code ?? -1));
  });
}

export async function estimateVideoFromSample(opts: {
  convert: VideoDecision[];
  copy: VideoDecision[];
  ffmpeg: FfmpegInfo;
  policy: VideoPolicy;
  sampleSize?: number;
  flatRatio?: number;
}): Promise<Estimate> {
  const started = Date.now();
  const totalConvert = opts.convert.length;
  const totalConvertBytes = opts.convert.reduce((a, d) => a + d.file.size, 0);
  const totalCopyBytes = opts.copy.reduce((a, d) => a + d.file.size, 0);
  const spec = VIDEO_FORMAT_SPECS[opts.policy.outputFormat];
  const fallbackRatio = opts.flatRatio ?? spec.defaultRatio;

  const sampleCount = Math.max(1, Math.min(opts.sampleSize ?? 5, 12));
  const sample = stratifiedSample(opts.convert, sampleCount);

  if (sample.length === 0) {
    return {
      sampleSize: 0,
      sampledBytes: 0,
      producedBytes: 0,
      ratio: fallbackRatio,
      meanOutputBytes: 0,
      secondsPerImage: 0,
      projectedOutputBytes: totalCopyBytes,
      projectedSeconds: 0,
      totalConvert: 0,
      totalConvertBytes: 0,
      method: "flat",
      durationMs: 0,
      format: opts.policy.outputFormat as unknown as OutputFormat,
    };
  }

  const scratch = await mkdtemp(path.join(tmpdir(), "picmagic-vid-est-"));
  let sampledSourceEquivalentBytes = 0;
  let producedSliceBytes = 0;
  let totalSampleDurationSec = 0;
  let encodedSliceDurationSec = 0;
  let encodeWallMs = 0;
  let successCount = 0;

  try {
    await mkdir(scratch, { recursive: true });

    const hwEncoderName =
      opts.policy.outputFormat === "av1_hw"
        ? opts.ffmpeg.hwEncoders.av1
        : opts.policy.outputFormat === "hevc_hw"
          ? opts.ffmpeg.hwEncoders.hevc
          : null;

    for (let i = 0; i < sample.length; i++) {
      const d = sample[i];
      const facts = await probeVideo(
        opts.ffmpeg.ffprobePath,
        d.file.abs,
        d.file.mtime,
        d.file.size,
      );
      const dur = facts.durationSec && facts.durationSec > 0 ? facts.durationSec : 10;

      // Take a 3-second slice at 40% into the video (or full duration if shorter than 4s)
      const sliceDur = dur <= 4 ? dur : 3;
      const sliceStart = dur <= 4 ? 0 : Number((dur * 0.4).toFixed(2));
      const ext = opts.policy.outputFormat === "vp9" ? "webm" : opts.policy.container;
      const outSlice = path.join(scratch, `sample-${i}.${ext}`);

      const buildSliceArgs = (startSec: number) =>
        buildVideoEncoderArgs({
          src: d.file.abs,
          out: outSlice,
          format: opts.policy.outputFormat,
          container: opts.policy.container,
          quality: opts.policy.quality,
          speed: opts.policy.speed,
          maxResolution: opts.policy.maxResolution,
          maxFps: opts.policy.maxFps,
          audioMode: opts.policy.audioMode,
          sourceAudioCodec: facts.audioCodec,
          sourceFps: facts.fps,
          isHdr: facts.isHdr,
          colorTransfer: facts.colorTransfer,
          tenBit: opts.policy.tenBit,
          filmGrain: opts.policy.filmGrain,
          customParams: opts.policy.customParams,
          hwEncoderName,
          sliceStartSec: startSec,
          sliceDurationSec: sliceDur,
        });

      let t0 = Date.now();
      let code = await runFfmpegSlice(opts.ffmpeg.ffmpegPath, buildSliceArgs(sliceStart));
      let elapsedMs = Date.now() - t0;

      let sliceBytes = 0;
      if (code === 0) {
        try {
          sliceBytes = (await stat(outSlice)).size;
        } catch {
          sliceBytes = 0;
        }
      }

      // Fast seeking lands on the previous keyframe. On long-GOP screen
      // recordings the only keyframe can be at 0s, so a 40% seek jumps past
      // EOF and leaves a tiny header. Retry from the start before giving up.
      if (sliceBytes < 1024 && sliceStart > 0) {
        await rm(outSlice, { force: true }).catch(() => {});
        t0 = Date.now();
        code = await runFfmpegSlice(opts.ffmpeg.ffmpegPath, buildSliceArgs(0));
        elapsedMs = Date.now() - t0;
        if (code === 0) {
          try {
            sliceBytes = (await stat(outSlice)).size;
          } catch {
            sliceBytes = 0;
          }
        }
      }

      if (code !== 0 || sliceBytes === 0) continue;

      try {
        const sliceFraction = sliceDur / dur;
        sampledSourceEquivalentBytes += Math.round(d.file.size * sliceFraction);
        producedSliceBytes += sliceBytes;
        totalSampleDurationSec += dur;
        encodedSliceDurationSec += sliceDur;
        encodeWallMs += elapsedMs;
        successCount++;
      } catch {
        /* ignore failed slice */
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }

  const ratio =
    sampledSourceEquivalentBytes > 0
      ? Math.min(1.0, producedSliceBytes / sampledSourceEquivalentBytes)
      : fallbackRatio;

  // Extrapolate how long a full average video takes based on slice encode speed
  const meanVideoDuration =
    successCount > 0 ? totalSampleDurationSec / successCount : 15;
  const encodeSecPerVideoSec =
    encodedSliceDurationSec > 0 ? encodeWallMs / 1000 / encodedSliceDurationSec : 1.0;
  const secondsPerVideo = meanVideoDuration * encodeSecPerVideoSec;

  const projectedOutputBytes = Math.round(totalConvertBytes * ratio + totalCopyBytes);
  const projectedSeconds = secondsPerVideo * totalConvert;

  return {
    sampleSize: successCount,
    sampledBytes: sampledSourceEquivalentBytes,
    producedBytes: producedSliceBytes,
    ratio,
    meanOutputBytes:
      totalConvert > 0 ? Math.round((totalConvertBytes * ratio) / totalConvert) : 0,
    secondsPerImage: secondsPerVideo,
    projectedOutputBytes,
    projectedSeconds,
    totalConvert,
    totalConvertBytes,
    method: successCount > 0 ? "sampled" : "flat",
    durationMs: Date.now() - started,
    format: opts.policy.outputFormat as unknown as OutputFormat,
  };
}
