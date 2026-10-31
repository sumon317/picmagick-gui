/**
 * Reading video facts via ffprobe (duration, codec, resolution, framerate,
 * HDR transfer, QuickTime creation_time), post-convert verification, and
 * lossless PNG frame extraction for the visual Compare inspector.
 */
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import type { FileResult } from "../convert.ts";
import { runPool } from "../convert.ts";
import { dateFromName, type DateReport } from "../meta.ts";
import type { ScannedFile } from "../scan.ts";
import type { VerifyReport, VerifyRow } from "../verify.ts";

export type VideoFacts = {
  path: string;
  ok: boolean;
  durationSec?: number;
  videoCodec?: string;
  audioCodec?: string;
  width?: number;
  height?: number;
  fps?: number;
  bitrateBps?: number;
  pixFmt?: string;
  isHdr?: boolean;
  colorTransfer?: string;
  dateOriginal?: string;
  make?: string;
  model?: string;
  gps?: string;
  filesize?: number;
  error?: string;
};

/** In-memory cache keyed by `${absPath}:${mtime}:${size}` so sliders never re-probe disk. */
const probeCache = new Map<string, VideoFacts>();
const MAX_CACHE_ENTRIES = 20_000;

function parseFrameRate(raw: unknown): number | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const parts = raw.trim().split("/");
  if (parts.length === 2) {
    const num = Number(parts[0]);
    const den = Number(parts[1]);
    if (Number.isFinite(num) && Number.isFinite(den) && den > 0) {
      return Number((num / den).toFixed(3));
    }
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Normalize ISO 8601 QuickTime/MP4 creation_time (e.g. "2026-07-24T22:54:58.000000Z")
 * into "YYYY:MM:DD HH:MM:SS" to match src/meta.ts.
 */
function normaliseCreationTime(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2}):(\d{2})/.exec(raw.trim());
  if (m) {
    return `${m[1]}:${m[2]}:${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
  }
  if (/^\d{4}:\d{2}:\d{2}\s+\d{2}:\d{2}:\d{2}/.test(raw.trim())) {
    return raw.trim().slice(0, 19);
  }
  return undefined;
}

export function probeVideo(
  ffprobePath: string,
  file: string,
  mtime?: number,
  size?: number,
): Promise<VideoFacts> {
  const cacheKey = mtime != null && size != null ? `${file}:${mtime}:${size}` : null;
  if (cacheKey) {
    const hit = probeCache.get(cacheKey);
    if (hit) return Promise.resolve(hit);
  }

  return new Promise((resolve) => {
    const child = spawn(
      ffprobePath,
      [
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        file,
      ],
      { windowsHide: true },
    );

    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      if (out.length < 64_000) out += String(d);
    });
    child.stderr.on("data", (d) => {
      if (err.length < 4_000) err += String(d);
    });

    child.on("error", (e) =>
      resolve({ path: file, ok: false, error: String(e.message ?? e) }),
    );

    child.on("close", (code) => {
      if (code !== 0 || !out.trim()) {
        resolve({
          path: file,
          ok: false,
          error: err.trim().slice(0, 240) || `ffprobe exited with code ${code}`,
        });
        return;
      }

      try {
        const parsed = JSON.parse(out) as {
          streams?: Array<Record<string, any>>;
          format?: Record<string, any>;
        };
        const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
        const vStream = streams.find((s) => s.codec_type === "video");
        const aStream = streams.find((s) => s.codec_type === "audio");
        const fmt = parsed.format ?? {};
        const fmtTags = fmt.tags ?? {};
        const vTags = vStream?.tags ?? {};

        if (!vStream) {
          resolve({ path: file, ok: false, error: "No video stream found" });
          return;
        }

        const durationSec = Number(fmt.duration ?? vStream.duration ?? 0);
        const bitrateBps = Number(fmt.bit_rate ?? vStream.bit_rate ?? 0);
        const filesize = Number(fmt.size ?? size ?? 0);
        const width = Number(vStream.width ?? 0);
        const height = Number(vStream.height ?? 0);
        const fps =
          parseFrameRate(vStream.avg_frame_rate) ??
          parseFrameRate(vStream.r_frame_rate);

        const transfer = String(vStream.color_transfer ?? "").toLowerCase();
        const isHdr = transfer === "smpte2084" || transfer === "arib-std-b67";

        const rawDate =
          fmtTags.creation_time ??
          fmtTags["com.apple.quicktime.creationdate"] ??
          vTags.creation_time;

        const facts: VideoFacts = {
          path: file,
          ok: true,
          durationSec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : undefined,
          videoCodec: typeof vStream.codec_name === "string" ? vStream.codec_name.toLowerCase() : undefined,
          audioCodec: typeof aStream?.codec_name === "string" ? aStream.codec_name.toLowerCase() : undefined,
          width: width > 0 ? width : undefined,
          height: height > 0 ? height : undefined,
          fps,
          bitrateBps: Number.isFinite(bitrateBps) && bitrateBps > 0 ? bitrateBps : undefined,
          pixFmt: typeof vStream.pix_fmt === "string" ? vStream.pix_fmt : undefined,
          isHdr,
          colorTransfer: isHdr ? transfer : undefined,
          dateOriginal: normaliseCreationTime(rawDate),
          make: fmtTags["com.apple.quicktime.make"] ?? fmtTags.make,
          model: fmtTags["com.apple.quicktime.model"] ?? fmtTags.model,
          gps: fmtTags["com.apple.quicktime.location.ISO6709"] ?? fmtTags.location,
          filesize: Number.isFinite(filesize) && filesize > 0 ? filesize : undefined,
        };

        if (cacheKey) {
          if (probeCache.size >= MAX_CACHE_ENTRIES) {
            const oldestKey = probeCache.keys().next().value;
            if (oldestKey) probeCache.delete(oldestKey);
          }
          probeCache.set(cacheKey, facts);
        }

        resolve(facts);
      } catch (e) {
        resolve({
          path: file,
          ok: false,
          error: `Unreadable ffprobe JSON: ${(e as Error).message}`,
        });
      }
    });
  });
}

export async function probeManyVideos(
  ffprobePath: string,
  files: ScannedFile[],
  jobs = 8,
  signal?: AbortSignal,
): Promise<VideoFacts[]> {
  const out: VideoFacts[] = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(jobs, files.length || 1)) }, async () => {
      while (cursor < files.length && !signal?.aborted) {
        const f = files[cursor++];
        out.push(await probeVideo(ffprobePath, f.abs, f.mtime, f.size));
      }
    }),
  );
  return out;
}

export function buildVideoDateReport(facts: VideoFacts[]): DateReport {
  const byYear: Record<string, number> = {};
  const undated: string[] = [];
  let withExif = 0;
  let fromNameOnly = 0;

  for (const f of facts) {
    let when: string | null = f.dateOriginal ?? null;
    if (when) {
      withExif++;
    } else {
      const base = f.path.split(/[\\/]/).pop() ?? f.path;
      when = dateFromName(base);
      if (when) fromNameOnly++;
      else undated.push(f.path);
    }
    const year = when?.slice(0, 4);
    if (year) byYear[year] = (byYear[year] ?? 0) + 1;
  }

  return { total: facts.length, withExif, fromNameOnly, undated, byYear };
}

/**
 * Extract a single video frame at `timestampSec` as a lossless PNG image so
 * the browser's Compare inspector can display pixel-exact split/zoom comparisons.
 */
export function extractVideoFramePng(
  ffmpegPath: string,
  videoFile: string,
  timestampSec: number,
  outPngPath: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    const args: string[] = ["-hide_banner", "-nostdin", "-y"];
    if (timestampSec > 0) {
      args.push("-ss", timestampSec.toFixed(3));
    }
    args.push(
      "-i",
      videoFile,
      "-frames:v",
      "1",
      "-pix_fmt",
      "rgb24",
      outPngPath,
    );

    const child = spawn(ffmpegPath, args, { windowsHide: true, stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", async (code) => {
      if (code !== 0) {
        resolve(false);
        return;
      }
      try {
        const st = await stat(outPngPath);
        resolve(st.size > 0);
      } catch {
        resolve(false);
      }
    });
  });
}

/**
 * Post-conversion verification for video runs: decodes the output headers via
 * ffprobe, verifies non-zero dimensions, checks duration against the source,
 * and checks whether capture timestamps survived.
 */
export async function verifyVideoOutputs(
  results: FileResult[],
  ffprobePath: string,
  opts: { jobs?: number; limit?: number; signal?: AbortSignal } = {},
): Promise<VerifyReport> {
  const started = Date.now();
  const produced = results.filter(
    (r) => r.out && (r.status === "converted" || r.status === "copied"),
  );
  const sample = opts.limit ? produced.slice(0, opts.limit) : produced;
  const rows: VerifyRow[] = [];

  await runPool(
    sample,
    opts.signal ?? new AbortController().signal,
    async (r) => {
      const problems: string[] = [];
      let src: VideoFacts | undefined;
      let out: VideoFacts | undefined;

      try {
        const st = await stat(r.out!);
        if (st.size === 0) problems.push("output is empty");
        if (r.status === "converted") {
          [src, out] = await Promise.all([
            probeVideo(ffprobePath, r.src),
            probeVideo(ffprobePath, r.out!),
          ]);
        } else {
          out = await probeVideo(ffprobePath, r.out!);
        }
      } catch (err) {
        problems.push((err as Error).message.slice(0, 120));
      }

      if (out && !out.ok) {
        problems.push(`cannot probe output: ${out.error ?? "unknown"}`);
      }
      if (out?.width !== undefined && out?.height !== undefined && (out.width === 0 || out.height === 0)) {
        problems.push("zero video dimensions");
      }
      if (
        src?.durationSec &&
        out?.durationSec &&
        Math.abs(src.durationSec - out.durationSec) > 1.5
      ) {
        problems.push(
          `duration mismatch (${src.durationSec.toFixed(1)}s -> ${out.durationSec.toFixed(1)}s)`,
        );
      }
      const dateKept =
        r.status === "copied"
          ? Boolean(out?.dateOriginal)
          : Boolean(src?.dateOriginal) && Boolean(out?.dateOriginal);
      if (r.status === "converted" && src?.dateOriginal && !out?.dateOriginal) {
        problems.push("QuickTime/container creation_time was lost");
      }

      rows.push({
        rel: r.rel,
        out: r.out!,
        ok: problems.length === 0,
        problems,
        srcWidth: src?.width,
        outWidth: out?.width,
        srcHeight: src?.height,
        outHeight: out?.height,
        bytes: r.outBytes,
        dateKept,
      });
    },
    () => false,
    () => Math.max(1, Math.min(opts.jobs ?? 8, 16)),
  );

  return {
    checked: rows.length,
    passed: rows.filter((r) => r.ok).length,
    failed: rows.filter((r) => !r.ok).length,
    dateSurvived: rows.filter((r) => r.dateKept).length,
    rows: rows.sort((a, b) => Number(a.ok) - Number(b.ok)),
    durationMs: Date.now() - started,
  };
}
