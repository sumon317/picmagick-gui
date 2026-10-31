/**
 * Turns a small real sample into a trustworthy size + time projection.
 *
 * A flat ratio guessed up front is wrong when your library mixes 400 KB phone
 * screenshots with 65 MB RAW. This converts an actual stratified sample and
 * measures what came out.
 */
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Decision } from "./policy.ts";
import { outputPathFor, type Policy } from "./policy.ts";
import { runPool } from "./convert.ts";
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { buildEncoderArgs, sourceArgFor, type OutputFormat } from "./formats.ts";
import { applyProcessCpuLimit } from "./cpu.ts";

export type Estimate = {
  sampleSize: number;
  sampledBytes: number;
  producedBytes: number;
  /** measured output / input on the sample */
  ratio: number;
  meanOutputBytes: number;
  /** seconds per image at a single job, measured */
  secondsPerImage: number;
  projectedOutputBytes: number;
  projectedSeconds: number;
  totalConvert: number;
  totalConvertBytes: number;
  method: "sampled" | "flat";
  durationMs: number;
  /** Which output format this measurement describes. */
  format: OutputFormat;
};

/** Even stride through the (folder-ordered) list so every folder gets represented. */
export function stratifiedSample<T>(items: T[], n: number): T[] {
  if (items.length <= n) return [...items];
  const step = items.length / n;
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(items[Math.floor(i * step)]);
  return out;
}

function magick(args: string[], exe: string): Promise<number> {
  return new Promise((resolve) => {
    const c = spawn(exe, args, {
      windowsHide: true,
      stdio: "ignore",
      env: {
        ...process.env,
        MAGICK_THREAD_LIMIT: "1",
        OMP_NUM_THREADS: "1",
      },
    });
    if (c.pid) applyProcessCpuLimit(c.pid, 70);
    c.on("error", () => resolve(-1));
    c.on("close", (code) => resolve(code ?? -1));
  });
}

export async function estimateFromSample(opts: {
  convert: Decision[];
  copy: Decision[];
  sourceRoot: string;
  magickPath: string;
  policy: Policy;
  jobs: number;
  sampleSize: number;
  flatRatio: number;
  keepScratch?: boolean;
}): Promise<Estimate> {
  const started = Date.now();
  const totalConvert = opts.convert.length;
  const totalConvertBytes = opts.convert.reduce((a, d) => a + d.file.size, 0);
  const totalCopyBytes = opts.copy.reduce((a, d) => a + d.file.size, 0);
  const variants = Math.max(1, opts.policy.qualities.length);

  const sample = stratifiedSample(opts.convert, opts.sampleSize);

  if (sample.length === 0) {
    return {
      sampleSize: 0, sampledBytes: 0, producedBytes: 0,
      ratio: opts.flatRatio, meanOutputBytes: 0, secondsPerImage: 0,
      projectedOutputBytes: totalCopyBytes,
      projectedSeconds: 0, totalConvert: 0, totalConvertBytes: 0,
      method: "flat", durationMs: 0,
      format: opts.policy.outputFormat,
    };
  }

  const scratch = await mkdtemp(path.join(tmpdir(), "picmagic-est-"));
  const sampledBytes = sample.reduce((a, d) => a + d.file.size, 0);
  let producedBytes = 0;
  let producedCount = 0;

  try {
    await mkdir(scratch, { recursive: true });

    await runPool(sample, new AbortController().signal, async (d) => {
      // Only the primary quality is measured; scaling by variant count is exact
      // enough because every variant is its own encode.
      const q = opts.policy.qualities[0];
      const out = outputPathFor(d, opts.sourceRoot, scratch, opts.policy, q);
      await mkdir(path.dirname(out), { recursive: true });
      const srcArg = sourceArgFor(
        d.file.abs,
        d.file.ext,
        opts.policy.outputFormat,
        opts.policy.flattenGif,
      );
      const code = await magick(
        buildEncoderArgs({
          srcArg,
          out,
          format: opts.policy.outputFormat,
          quality: q,
          speed: opts.policy.heicSpeed,
          maxResolution: opts.policy.maxResolution,
          stripMetadata: opts.policy.stripMetadata,
        }),
        opts.magickPath,
      );
      if (code !== 0) return;
      try {
        const st = await stat(out);
        // The smaller-only guard keeps the source bytes when a single-quality
        // encode would be larger, so the sample must not project the inflated
        // size either.
        const measured =
          opts.policy.skipAlreadyEfficient !== false && opts.policy.qualities.length === 1
            ? Math.min(st.size, d.file.size)
            : st.size;
        producedBytes += measured;
        producedCount++;
      } catch { /* no output */ }
    },
    () => false,                       // a sample always runs to the end
    () => Math.max(1, Math.min(opts.jobs, 16)),
    );
  } finally {
    if (!opts.keepScratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }

  const elapsed = (Date.now() - started) / 1000;
  const ratio = sampledBytes > 0 ? producedBytes / sampledBytes : opts.flatRatio;
  // Wall time at N jobs divided by N gives per-image service time.
  const secondsPerImage = producedCount > 0 ? (elapsed / producedCount) * opts.jobs : 0;

  const projectedOutputBytes = Math.round(totalConvertBytes * ratio * variants + totalCopyBytes);
  const projectedSeconds = secondsPerImage * totalConvert;

  return {
    sampleSize: sample.length,
    sampledBytes,
    producedBytes,
    ratio,
    meanOutputBytes: producedCount > 0 ? producedBytes / producedCount : 0,
    secondsPerImage,
    projectedOutputBytes,
    projectedSeconds,
    totalConvert,
    totalConvertBytes,
    method: "sampled",
    durationMs: Date.now() - started,
    format: opts.policy.outputFormat,
  };
}