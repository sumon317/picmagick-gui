/**
 * Preflight health checks for the Video tab.
 */
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type { HealthCheck } from "../health.ts";
import { assertDestinationSafe, freeSpace } from "../paths.ts";
import { findFfmpeg, type FfmpegInfo } from "./ffmpeg.ts";
import { VIDEO_FORMAT_SPECS, type VideoOutputFormat } from "./formats.ts";

export type VideoHealthReport = {
  checks: HealthCheck[];
  ffmpeg: FfmpegInfo | null;
  canRun: boolean;
  freeBytes: number | null;
};

export async function runVideoHealthCheck(
  sourceRoot: string,
  effectiveDestination: string,
  expectedOutputBytes: number,
  format: VideoOutputFormat = "av1",
): Promise<VideoHealthReport> {
  const checks: HealthCheck[] = [];
  let ffmpeg: FfmpegInfo | null = null;

  try {
    ffmpeg = findFfmpeg();
    checks.push({
      id: "ffmpeg",
      label: "FFmpeg + FFprobe",
      status: "ok",
      detail: `${ffmpeg.version}${ffmpeg.managed ? " (managed)" : ""}`,
    });
  } catch (err) {
    checks.push({
      id: "ffmpeg",
      label: "FFmpeg + FFprobe",
      status: "fail",
      detail: (err as Error).message.split("\n")[0],
    });
  }

  if (ffmpeg) {
    const spec = VIDEO_FORMAT_SPECS[format];
    const support = ffmpeg.formats[format];
    const writable = support?.writable ?? false;
    checks.push({
      id: "video-format",
      label: `${spec.label} encoder`,
      status: writable ? "ok" : "fail",
      detail: writable
        ? `${spec.label} ready via ${support.detail ?? support.mode}`
        : `${spec.label} unavailable (${support?.detail ?? "encoder missing"})`,
    });
  }

  try {
    const st = await stat(sourceRoot);
    if (st.isDirectory()) await access(sourceRoot, constants.R_OK);
    checks.push({
      id: "source",
      label: "Source readable",
      status: st.isDirectory() ? "ok" : "fail",
      detail: sourceRoot,
    });
  } catch (err) {
    checks.push({
      id: "source",
      label: "Source readable",
      status: "fail",
      detail: (err as Error).message,
    });
  }

  try {
    assertDestinationSafe(sourceRoot, effectiveDestination);
  } catch (err) {
    checks.push({
      id: "dest-safe",
      label: "Output safety",
      status: "fail",
      detail: (err as Error).message,
    });
  }

  try {
    const st = await stat(effectiveDestination);
    if (!st.isDirectory()) {
      checks.push({
        id: "dest",
        label: "Output writable",
        status: "fail",
        detail: `${effectiveDestination} is a file, not a directory`,
      });
    } else {
      await access(effectiveDestination, constants.W_OK);
      checks.push({
        id: "dest",
        label: "Output writable",
        status: "ok",
        detail: effectiveDestination,
      });
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      let ancestor = path.dirname(path.resolve(effectiveDestination));
      while (ancestor && ancestor !== path.dirname(ancestor)) {
        try {
          await stat(ancestor);
          break;
        } catch {
          ancestor = path.dirname(ancestor);
        }
      }
      let parentWritable = false;
      try {
        await access(ancestor, constants.W_OK);
        parentWritable = true;
      } catch {
        // not writable
      }
      checks.push({
        id: "dest",
        label: "Output writable",
        status: parentWritable ? "warn" : "fail",
        detail: parentWritable
          ? `${effectiveDestination} - will be created`
          : `${effectiveDestination} - parent folder "${ancestor}" is not writable`,
      });
    } else {
      checks.push({
        id: "dest",
        label: "Output writable",
        status: "fail",
        detail: `${effectiveDestination} - not writable (${(err as Error).message.slice(0, 60)})`,
      });
    }
  }

  const free = await freeSpace(effectiveDestination);
  if (free === null) {
    checks.push({
      id: "disk",
      label: "Disk space",
      status: "warn",
      detail: "could not determine free space",
    });
  } else {
    const headroom = free - expectedOutputBytes;
    checks.push({
      id: "disk",
      label: "Disk space",
      status: headroom > 1024 ** 3 ? "ok" : headroom > 0 ? "warn" : "fail",
      detail:
        `${(free / 1024 ** 3).toFixed(1)} GB free, need ~${(expectedOutputBytes / 1024 ** 3).toFixed(2)} GB` +
        (headroom > 0 ? ` (${(headroom / 1024 ** 3).toFixed(1)} GB spare)` : " - NOT ENOUGH"),
    });
  }

  const canRun = !checks.some((c) => c.status === "fail");
  return { checks, ffmpeg, canRun, freeBytes: free };
}
