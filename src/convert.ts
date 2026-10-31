/**
 * The magick.exe worker pool.
 *
 * Hard invariant #1 lives here: the source tree is opened read-only and never
 * written to. Every write goes through outputPathFor() into the destination.
 */
import { spawn } from "node:child_process";
import { copyFile, mkdir, rename, stat, rm, utimes } from "node:fs/promises";
import path from "node:path";
import type { Decision } from "./policy.ts";
import { outputPathFor, type Policy } from "./policy.ts";
import { buildEncoderArgs, sourceArgFor } from "./formats.ts";
import { applyProcessCpuLimit } from "./cpu.ts";

export type FileStatus = "converted" | "copied" | "skipped" | "failed" | "cancelled";

export type FileResult = {
  rel: string;
  src: string;
  out: string | null;
  status: FileStatus;
  seconds: number;
  inBytes: number;
  outBytes: number;
  error?: string;
  /** Qualities that failed even though others succeeded. */
  partialErrors?: string[];
};

export type RunOptions = {
  sourceRoot: string;
  destination: string;
  magickPath: string;
  policy: Policy;
  jobs: number;
  cpuLimit?: number;
  /**
   * Live parallel-job count. Read before every dispatch so the user can change
   * it mid-run; falls back to the start value if not supplied.
   */
  getLimit?: () => number;
  /**
   * Live CPU limit percentage (10 - 100). Read before every dispatch.
   */
  getCpuLimit?: () => number;
  /** Mid-run child process registration for live CPU affinity updates. */
  onChildSpawn?: (pid: number) => void;
  onChildExit?: (pid: number) => void;
  overwrite: boolean;
  signal: AbortSignal;
  onStart: (rel: string, bytes: number) => void;
  onResult: (r: FileResult) => void;
};

const MB = 1024 * 1024;

function runMagick(
  exe: string,
  args: string[],
  signal: AbortSignal,
  cpuLimit = 70,
  onChildSpawn?: (pid: number) => void,
  onChildExit?: (pid: number) => void,
): Promise<{ code: number; signal: NodeJS.Signals | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(exe, args, {
      windowsHide: true,
      // On Linux, make the encoder a process-group leader so cancelling an
      // AppImage wrapper also terminates the inner magick it forked.
      detached: process.platform === "linux",
      env: {
        ...process.env,
        MAGICK_THREAD_LIMIT: "1",
        OMP_NUM_THREADS: "1",
      },
    });

    if (child.pid) {
      applyProcessCpuLimit(child.pid, cpuLimit);
      onChildSpawn?.(child.pid);
    }

    let stderr = "";
    child.stderr.on("data", (d) => {
      if (stderr.length < 8000) stderr += String(d);
    });

    const onAbort = () => {
      if (process.platform === "linux" && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
          /* not a group leader */
        }
      }
      try { child.kill(); } catch { /* already gone */ }
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

/**
 * Temporary sibling used for atomic output. The final rename is atomic on the
 * same volume, so a killed encode can never leave a truncated file that the
 * skip-existing check would treat as a finished conversion.
 */
function partPathFor(finalOut: string): string {
  const ext = path.extname(finalOut);
  const base = finalOut.slice(0, finalOut.length - ext.length);
  return `${base}.part-${process.pid}${ext}`;
}

async function processOne(d: Decision, o: RunOptions): Promise<FileResult> {
  const started = Date.now();
  const src = d.file.abs;

  // Tell the UI this file is now in flight. A single AV1 encode can run for
  // many seconds, and without this the progress bar sits at zero with no
  // indication anything is happening.
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

  if (o.signal.aborted) return { ...base, status: "cancelled", seconds: 0 };

  let activePart: string | null = null;

  try {
    if (d.verdict === "copy") {
      const out = outputPathFor(d, o.sourceRoot, o.destination, o.policy);
      if (!(await overwriteOk(out, o.overwrite))) {
        return { ...base, out, status: "skipped", seconds: (Date.now() - started) / 1000 };
      }
      await mkdir(path.dirname(out), { recursive: true });
      activePart = partPathFor(out);
      await copyFile(src, activePart);
      if (o.signal.aborted) {
        await rm(activePart, { force: true }).catch(() => {});
        activePart = null;
        return { ...base, status: "cancelled", seconds: (Date.now() - started) / 1000 };
      }
      const st = await stat(activePart);
      await rename(activePart, out);
      activePart = null;
      const mtimeDate = new Date(d.file.mtime);
      await utimes(out, mtimeDate, mtimeDate).catch(() => {});
      return {
        ...base,
        out,
        status: "copied",
        seconds: (Date.now() - started) / 1000,
        outBytes: st.size,
      };
    }

    // ---- convert ----
    let totalOut = 0;
    let anyWritten = false;
    let primaryOut: string | null = null;
    let lastErr = "";

    for (const q of o.policy.qualities) {
      const out = outputPathFor(d, o.sourceRoot, o.destination, o.policy, q);
      if (!(await overwriteOk(out, o.overwrite))) continue;

      await mkdir(path.dirname(out), { recursive: true });
      const partOut = partPathFor(out);
      activePart = partOut;
      await rm(partOut, { force: true }).catch(() => {});

      // Multi-frame sources become animated JXL/AVIF/WebP as-is. HEIC,
      // JPEG 2000, JPEG, and PNG select frame 0. flattenGif still selects
      // frame 0 for GIF sources.
      const srcArg = sourceArgFor(
        src,
        d.file.ext,
        o.policy.outputFormat,
        o.policy.flattenGif,
      );

      const args = buildEncoderArgs({
        srcArg,
        out: partOut,
        format: o.policy.outputFormat,
        quality: q,
        speed: o.policy.heicSpeed,
        maxResolution: o.policy.maxResolution,
        stripMetadata: o.policy.stripMetadata,
      });

      const cpuLimit = o.getCpuLimit ? o.getCpuLimit() : (o.cpuLimit ?? 70);
      const { code, signal, stderr } = await runMagick(
        o.magickPath,
        args,
        o.signal,
        cpuLimit,
        o.onChildSpawn,
        o.onChildExit,
      );

      // A user cancel also ends the child with a signal; don't misreport it as
      // an encoder crash or an out-of-memory kill.
      if (o.signal.aborted) {
        await rm(partOut, { force: true }).catch(() => {});
        activePart = null;
        return { ...base, status: "cancelled", seconds: (Date.now() - started) / 1000 };
      }

      if (code !== 0) {
        const detail = stderr.trim().split(/\r?\n/).slice(-2).join(" ").slice(0, 200);
        lastErr = detail || (signal
          ? `encoder was killed by ${signal} (likely out of memory)`
          : `encoder exited with code ${code}`);
        await rm(partOut, { force: true }).catch(() => {});
        activePart = null;
        continue;
      }

      try {
        const st = await stat(partOut);
        // aom exits 0 and writes a zero-byte file at heic:speed 10, so exit
        // code alone is not proof of success.
        if (st.size === 0) {
          lastErr = lastErr || "encoder wrote an empty file";
          await rm(partOut, { force: true }).catch(() => {});
          activePart = null;
          continue;
        }

        // Smaller-Only Guard: never inflate a single-quality photo. If the
        // encode is at least as large as the source, keep the original bytes
        // (with their original extension) instead.
        if (
          o.policy.skipAlreadyEfficient !== false &&
          o.policy.qualities.length === 1 &&
          st.size >= d.file.size
        ) {
          await rm(partOut, { force: true }).catch(() => {});
          activePart = null;
          const copyDecision: Decision = { ...d, verdict: "copy", reason: "undersized" };
          const copyOut = outputPathFor(copyDecision, o.sourceRoot, o.destination, o.policy);
          if (!(await overwriteOk(copyOut, o.overwrite))) {
            return { ...base, out: copyOut, status: "skipped", seconds: (Date.now() - started) / 1000 };
          }
          await mkdir(path.dirname(copyOut), { recursive: true });
          await copyFile(src, copyOut);
          const mtimeDate = new Date(d.file.mtime);
          await utimes(copyOut, mtimeDate, mtimeDate).catch(() => {});
          const origSt = await stat(copyOut);
          return {
            ...base,
            out: copyOut,
            status: "copied",
            seconds: (Date.now() - started) / 1000,
            outBytes: origSt.size,
          };
        }

        await rename(partOut, out);
        activePart = null;
        const mtimeDate = new Date(d.file.mtime);
        await utimes(out, mtimeDate, mtimeDate).catch(() => {});
        totalOut += st.size;
        anyWritten = true;
        if (!primaryOut) primaryOut = out;
      } catch {
        await rm(partOut, { force: true }).catch(() => {});
        activePart = null;
        lastErr = "encoder reported success but produced no file";
      }
    }

    const seconds = (Date.now() - started) / 1000;

    if (anyWritten) {
      // A multi-quality run can half-succeed. Say which variants are missing
      // rather than reporting a clean "converted".
      const partialErrors = lastErr ? [lastErr] : undefined;
      return {
        ...base, out: primaryOut, status: "converted", seconds,
        outBytes: totalOut, partialErrors,
      };
    }
    if (lastErr) {
      return { ...base, status: "failed", seconds, error: lastErr || "unknown error" };
    }
    // Everything was already on disk and overwrite was off.
    return { ...base, status: "skipped", seconds };
  } catch (err) {
    return {
      ...base,
      status: "failed",
      seconds: (Date.now() - started) / 1000,
      error: (err as Error).message,
    };
  } finally {
    if (activePart) {
      await rm(activePart, { force: true }).catch(() => {});
    }
  }
}

async function overwriteOk(out: string, overwrite: boolean): Promise<boolean> {
  if (overwrite) return true;
  try {
    const st = await stat(out);
    // A zero-byte file is a failed encode, not a finished conversion. Retry it
    // instead of treating it as an existing output forever.
    return st.size === 0;
  } catch {
    return true; // free
  }
}

/**
 * Runs `work` with at most `getLimit()` in flight.
 *
 * The limit is read before every dispatch rather than captured once, so the
 * parallel-job slider can be moved mid-run. Raising it starts work immediately;
 * lowering it stops new work from being handed out and lets the in-flight
 * encodes finish, so nothing is left half-written.
 *
 * `shouldStop` is checked the same way, between items. That is what makes
 * pause safe: work already in flight is allowed to land on disk rather than
 * being killed mid-encode and leaving a truncated file that the skip-existing
 * check would then treat as complete forever.
 */
export async function runPool<T>(
  items: T[],
  signal: AbortSignal,
  worker: (item: T, index: number) => Promise<void>,
  shouldStop: () => boolean = () => false,
  getLimit: () => number = () => 1,
): Promise<void> {
  let cursor = 0;
  const inFlight = new Set<Promise<unknown>>();

  const dispatch = () => {
    const limit = Math.max(1, Math.min(getLimit(), items.length));
    while (
      inFlight.size < limit &&
      cursor < items.length &&
      !shouldStop() &&
      !signal.aborted
    ) {
      const i = cursor++;
      const p = worker(items[i], i)
        .catch(() => { /* per-item failures are reported by the worker */ })
        .finally(() => { inFlight.delete(p); });
      inFlight.add(p);
    }
  };

  dispatch();
  while (inFlight.size > 0) {
    await Promise.race(inFlight);
    dispatch();
  }
}

export type ConversionSummary = {
  results: FileResult[];
  ok: number;
  failed: number;
  skipped: number;
  copied: number;
  bytes: number;
  seconds: number;
  /** True when the pool stopped early because of pause or cancel. */
  stoppedEarly: boolean;
  /** Results carrying a partial-quality error. */
  partial: number;
};

export async function runConversion(
  decisions: Decision[],
  options: RunOptions,
  shouldStop?: () => boolean,
): Promise<ConversionSummary> {
  const results: FileResult[] = [];
  const began = Date.now();
  await mkdir(options.destination, { recursive: true });

  await runPool(
    decisions, options.signal,
    async (d) => {
      const r = await processOne(d, options);
      results.push(r);
      options.onResult(r);
    },
    shouldStop,
    options.getLimit,
  );

  return {
    results,
    ok: results.filter((r) => r.status === "converted").length,
    copied: results.filter((r) => r.status === "copied").length,
    failed: results.filter((r) => r.status === "failed").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    partial: results.filter((r) => r.partialErrors?.length).length,
    bytes: results.reduce((a, r) => a + r.outBytes, 0),
    seconds: (Date.now() - began) / 1000,
    stoppedEarly: (shouldStop?.() ?? false) || options.signal.aborted,
  };
}

export const formatBytes = (n: number): string => {
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + " GB";
  if (n >= MB) return (n / MB).toFixed(1) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
  return n + " B";
};