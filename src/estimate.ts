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
  /** "sampled": ≥1 sample encoded and measured. "flat": nothing to sample -
   * clean structural guess. "unmeasured": samples were attempted and EVERY one
   * failed - the byte projection falls back to flatRatio, and time must be
   * read as unknown (projection is 0) instead of instant. */
  method: "sampled" | "flat" | "unmeasured";
  /** True only when nothing valid was sampled: zero means "unknown", not
   * "instant". Callers (server passthrough, client render) gate on this. */
  unmeasured: boolean;
  /** Why the projection is unmeasured. Present only when unmeasured is true. */
  unmeasuredReason?: string;
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

function magick(args: string[], exe: string, signal?: AbortSignal): Promise<number> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(-1);
      return;
    }
    const c = spawn(exe, args, {
      windowsHide: true,
      detached: process.platform === "linux",
      stdio: "ignore",
      env: {
        ...process.env,
        MAGICK_THREAD_LIMIT: "1",
        OMP_NUM_THREADS: "1",
      },
    });
    if (c.pid) applyProcessCpuLimit(c.pid, 70);
    const onAbort = () => {
      if (process.platform === "linux" && c.pid) {
        try { process.kill(-c.pid, "SIGKILL"); return; } catch { /* ignore */ }
      }
      try { c.kill(); } catch { /* ignore */ }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    c.on("error", () => { signal?.removeEventListener("abort", onAbort); resolve(-1); });
    c.on("close", (code) => { signal?.removeEventListener("abort", onAbort); resolve(code ?? -1); });
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
  signal?: AbortSignal;
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
      method: "flat", unmeasured: false, durationMs: 0,
      format: opts.policy.outputFormat,
    };
  }

  const scratch = await mkdtemp(path.join(tmpdir(), "picmagic-est-"));
  let measuredInputBytes = 0;
  let producedBytes = 0;
  let producedCount = 0;
  const effectiveJobs = Math.max(1, Math.min(opts.jobs, sample.length, 16));

  try {
    await mkdir(scratch, { recursive: true });

    await runPool(sample, opts.signal ?? new AbortController().signal, async (d) => {
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
        opts.signal,
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
        measuredInputBytes += d.file.size;
        producedBytes += measured;
        producedCount++;
      } catch { /* no output */ }
    },
    () => false,                       // a sample always runs to the end
    () => effectiveJobs,
    );
  } finally {
    if (!opts.keepScratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }

  const elapsed = (Date.now() - started) / 1000;
  const ratio = measuredInputBytes > 0 ? producedBytes / measuredInputBytes : opts.flatRatio;
  // Wall time at N jobs divided by N gives per-image service time.
  const secondsPerImage = producedCount > 0 ? (elapsed / producedCount) * effectiveJobs : 0;

  const projectedOutputBytes = Math.round(totalConvertBytes * ratio * variants + totalCopyBytes);
  const projectedSeconds = secondsPerImage * totalConvert * variants;

  // A sample run where NOTHING encoded has no measurement at all: the flat
  // ratio keeps the byte projection honest, but 0 seconds plus a "sampled"
  // label read as "instant", which is the lie. Say unmeasured instead.
  const unmeasured = producedCount === 0;

  return {
    sampleSize: producedCount,
    sampledBytes: measuredInputBytes,
    producedBytes,
    ratio,
    meanOutputBytes: producedCount > 0 ? producedBytes / producedCount : 0,
    secondsPerImage,
    projectedOutputBytes,
    projectedSeconds,
    totalConvert,
    totalConvertBytes,
    method: unmeasured ? "unmeasured" : "sampled",
    unmeasured,
    unmeasuredReason: unmeasured
      ? `all ${sample.length} samples failed to encode - bytes projected from flatRatio ${opts.flatRatio}, time unknown`
      : undefined,
    durationMs: Date.now() - started,
    format: opts.policy.outputFormat,
  };
}