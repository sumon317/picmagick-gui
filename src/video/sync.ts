/**
 * Incremental video sync analyzer.
 *
 * When `destMode === "merge"`, the destination directory holds both compressed
 * photos (from Tab 1) and compressed videos (from Tab 2). When scanning for
 * orphan outputs in the destination, this module explicitly ignores image
 * extensions so your compressed photos are never reported as video orphans.
 */
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { OUTPUT_FORMATS, FORMAT_SPECS } from "../formats.ts";
import { CONVERT_EXTS, RAW_EXTS, VIDEO_EXTS, extOf } from "../paths.ts";
import { pathKey } from "../platform.ts";
import type { SyncEntry, SyncReport, SyncState } from "../sync.ts";
import {
  videoOutputPathFor,
  type VideoDecision,
  type VideoPolicy,
} from "./policy.ts";

const CONC = 16;

const PHOTO_EXT_SET = new Set<string>([
  ...CONVERT_EXTS,
  ...RAW_EXTS,
  ...OUTPUT_FORMATS.map((f) => FORMAT_SPECS[f].ext),
]);

const VIDEO_EXT_SET = new Set<string>([...VIDEO_EXTS, "mp4", "mkv", "webm"]);

export async function analyseVideoSync(
  decisions: VideoDecision[],
  sourceRoot: string,
  effectiveDestination: string,
  policy: VideoPolicy,
): Promise<SyncReport> {
  const started = Date.now();
  const entries: SyncEntry[] = [];
  const expected = new Set<string>();
  let cursor = 0;

  await Promise.all(
    Array.from({ length: Math.min(CONC, decisions.length || 1) }, async () => {
      while (cursor < decisions.length) {
        const d = decisions[cursor++];
        const out = videoOutputPathFor(d, sourceRoot, effectiveDestination, policy);
        expected.add(pathKey(path.resolve(out)));

        // Also register the original-extension copy path as expected in case
        // skipAlreadyEfficient copied the source video verbatim on a prior run.
        const copyOut = videoOutputPathFor(
          { ...d, verdict: "copy" },
          sourceRoot,
          effectiveDestination,
          policy,
        );
        expected.add(pathKey(path.resolve(copyOut)));

        let present = false;
        let stale = false;
        let outBytes: number | null = null;
        let reason: string | undefined;
        let matchedOut = out;

        for (const candidate of [out, copyOut]) {
          try {
            const st = await stat(candidate);
            if (st.size === 0) {
              reason = "output is empty";
              continue;
            }
            matchedOut = candidate;
            outBytes = st.size;
            // Filesystem timestamp precision varies across NTFS/ext4/exFAT, so
            // allow a one-second rounding window before calling an output stale.
            if (st.mtimeMs + 1000 < d.file.mtime) {
              stale = true;
              reason = "output older than source";
            } else {
              present = true;
            }
            break;
          } catch {
            /* try next */
          }
        }

        const state: SyncState = !present ? (stale ? "changed" : "new") : "upToDate";

        entries.push({
          rel: d.file.rel,
          out: matchedOut,
          state,
          sourceBytes: d.file.size,
          outputBytes: outBytes,
          reason,
        });
      }
    }),
  );

  entries.sort((a, b) => a.rel.localeCompare(b.rel));

  const orphans: { out: string; bytes: number }[] = [];
  let orphanBytes = 0;

  async function walk(dir: string) {
    let entriesIn;
    try {
      entriesIn = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entriesIn) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!e.isFile()) continue;
      if (e.name.startsWith(".picmagic-manifest-") || e.name.startsWith(".compakta-manifest-")) continue;
      if (e.name.includes(".part.")) continue;

      const ext = extOf(e.name);
      // In "merge" mode, ignore photo outputs so only orphan videos are flagged
      if (PHOTO_EXT_SET.has(ext) && !VIDEO_EXT_SET.has(ext)) continue;

      if (expected.has(pathKey(path.resolve(full)))) continue;
      try {
        const st = await stat(full);
        orphans.push({ out: full, bytes: st.size });
        orphanBytes += st.size;
      } catch {
        /* raced */
      }
    }
  }

  await walk(effectiveDestination);

  const newCount = entries.filter((e) => e.state === "new").length;
  const changedCount = entries.filter((e) => e.state === "changed").length;
  const pending = entries.filter((e) => e.state !== "upToDate");

  return {
    total: entries.length,
    newCount,
    changedCount,
    upToDateCount: entries.filter((e) => e.state === "upToDate").length,
    pendingCount: pending.length,
    pendingSourceBytes: pending.reduce((a, e) => a + e.sourceBytes, 0),
    orphanCount: orphans.length,
    orphans: orphans.sort((a, b) => b.bytes - a.bytes).slice(0, 200),
    orphanBytes,
    entries,
    durationMs: Date.now() - started,
  };
}

export function pendingVideoOnly(
  decisions: VideoDecision[],
  report: SyncReport,
): VideoDecision[] {
  const pending = new Set(
    report.entries.filter((e) => e.state !== "upToDate").map((e) => e.rel),
  );
  return decisions.filter((d) => pending.has(d.file.rel));
}
