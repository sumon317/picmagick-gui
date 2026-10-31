/**
 * Post-convert verification.
 *
 * The exit code of an encoder is not proof. This decodes the outputs back and
 * checks that the pixels survived: it opens, dimensions match the source,
 * dimensions are non-zero, and the capture date is still attached.
 */
import { stat } from "node:fs/promises";
import type { FileResult } from "./convert.ts";
import { identify, type ImageFacts } from "./meta.ts";
import { runPool } from "./convert.ts";

export type VerifyRow = {
  rel: string;
  out: string;
  ok: boolean;
  problems: string[];
  srcWidth?: number;
  outWidth?: number;
  srcHeight?: number;
  outHeight?: number;
  bytes?: number;
  dateKept?: boolean;
};

export type VerifyReport = {
  checked: number;
  passed: number;
  failed: number;
  dateSurvived: number;
  rows: VerifyRow[];
  durationMs: number;
};

/** True when EXIF orientation rotates the image by 90° or 270°, swapping width and height. */
function swapsDimensionsOnAutoOrient(orientation: string | undefined): boolean {
  if (!orientation) return false;
  return /^(LeftTop|RightTop|RightBottom|LeftBottom|5|6|7|8)$/i.test(orientation.trim());
}

export async function verifyOutputs(
  results: FileResult[],
  magickPath: string,
  opts: { jobs?: number; limit?: number; signal?: AbortSignal } = {},
): Promise<VerifyReport> {
  const started = Date.now();
  const produced = results.filter((r) => r.status === "converted" || r.status === "copied");
  const sample = opts.limit ? produced.slice(0, opts.limit) : produced;
  const rows: VerifyRow[] = [];

  await runPool(sample, opts.signal ?? new AbortController().signal, async (r) => {
    const problems: string[] = [];
    let src: ImageFacts | undefined;
    let out: ImageFacts | undefined;

    try {
      const st = await stat(r.out!);
      if (st.size === 0) problems.push("output is empty");
      // Copied files are byte-identical by construction; only conversions need decoding.
      if (r.status === "converted") {
        [src, out] = await Promise.all([identify(magickPath, r.src), identify(magickPath, r.out!)]);
      } else {
        out = await identify(magickPath, r.out!);
      }
    } catch (err) {
      problems.push((err as Error).message.slice(0, 120));
    }

    if (out && !out.ok) problems.push(`cannot decode: ${out.error ?? "unknown"}`);
    if (out?.width !== undefined && out?.height !== undefined && (out.width === 0 || out.height === 0)) {
      problems.push("zero dimensions");
    }

    const swapped = swapsDimensionsOnAutoOrient(src?.orientation);
    const expectedWidth = swapped ? src?.height : src?.width;
    const expectedHeight = swapped ? src?.width : src?.height;

    if (expectedWidth && out?.width && expectedWidth !== out.width) {
      problems.push(`width changed ${expectedWidth} -> ${out.width}`);
    }
    if (expectedHeight && out?.height && expectedHeight !== out.height) {
      problems.push(`height changed ${expectedHeight} -> ${out.height}`);
    }

    const dateKept =
      r.status === "copied"
        ? Boolean(out?.dateOriginal)
        : Boolean(src?.dateOriginal) && Boolean(out?.dateOriginal);
    if (r.status === "converted" && src?.dateOriginal && !out?.dateOriginal) {
      problems.push("EXIF DateTimeOriginal was lost");
    }

    rows.push({
      rel: r.rel,
      out: r.out!,
      ok: problems.length === 0,
      problems,
      srcWidth: expectedWidth,
      outWidth: out?.width,
      srcHeight: expectedHeight,
      outHeight: out?.height,
      bytes: r.outBytes,
      dateKept,
    });
  },
  () => false,                              // never stop early
  () => Math.max(1, Math.min(opts.jobs ?? 8, 32)),
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