/**
 * Incremental sync: work out what still needs doing.
 *
 * The output layout is deterministic, so for every decided source file we can
 * compute exactly where its output should be and check whether it is already
 * there and current. That gives four states:
 *
 *   new       no output yet                     -> convert
 *   changed   output older than the source      -> convert
 *   upToDate  output present and not stale      -> skip
 *   orphan    output with no matching source    -> report only, never delete
 *
 * Deliberately mtime-based rather than hash-based: a re-run over 11k files has
 * to be cheap, and the only thing that can go stale unnoticed is someone
 * re-saving or replacing a source file in place.
 */
import { stat, readdir } from "node:fs/promises";
import path from "node:path";
import type { Decision } from "./policy.ts";
import { outputPathFor, type Policy } from "./policy.ts";
import { pathKey } from "./platform.ts";
import { VIDEO_EXTS, extOf } from "./paths.ts";

const VIDEO_EXT_SET = new Set<string>(VIDEO_EXTS);

export type SyncState = "new" | "changed" | "upToDate";

export type SyncEntry = {
  rel: string;
  out: string | null;
  state: SyncState;
  sourceBytes: number;
  outputBytes: number | null;
  /** Why it counts as changed. */
  reason?: string;
};

export type SyncReport = {
  total: number;
  newCount: number;
  changedCount: number;
  upToDateCount: number;
  /** Source bytes still to be processed. */
  pendingSourceBytes: number;
  pendingCount: number;
  /** Total orphans found, before the display list is capped at 200. */
  orphanCount: number;
  orphans: { out: string; bytes: number }[];
  orphanBytes: number;
  entries: SyncEntry[];
  durationMs: number;
};

const CONC = 16;

export async function analyseSync(
  decisions: Decision[],
  sourceRoot: string,
  destination: string,
  policy: Policy,
): Promise<SyncReport> {
  const started = Date.now();
  const entries: SyncEntry[] = [];
  const expected = new Set<string>();
  let cursor = 0;

  await Promise.all(
    Array.from({ length: Math.min(CONC, decisions.length || 1) }, async () => {
      while (cursor < decisions.length) {
        const d = decisions[cursor++];
        // Multi-quality runs produce one output per quality; the source is only
        // "done" when every variant is present.
        const outs = policy.qualities.map((q) =>
          outputPathFor(d, sourceRoot, destination, policy, q));

        let allPresent = true;
        let anyStale = false;
        let outBytes: number | null = null;
        let reason: string | undefined;
        let matchedOut: string | null = outs[0] ?? null;

        for (const o of outs) {
          expected.add(pathKey(path.resolve(o)));
          try {
            const st = await stat(o);
            outBytes = (outBytes ?? 0) + st.size;
            if (st.size === 0) {
              // A zero-byte file is a failed encode, not a finished output.
              allPresent = false;
              reason = "output is empty";
              continue;
            }
            // Filesystem timestamp precision varies across NTFS/ext4/exFAT, so
            // allow a one-second rounding window before calling an output stale.
            if (st.mtimeMs + 1000 < d.file.mtime) {
              allPresent = false;
              anyStale = true;
              reason = "output older than source";
            }
          } catch {
            allPresent = false;
          }
        }

        // The smaller-only guard can keep the original bytes instead of writing
        // a converted file. Register that copy path as expected so it is never
        // reported as an orphan, then use it as a finished output when the
        // converted variants are missing or stale.
        const guardApplies =
          policy.qualities.length === 1 && policy.skipAlreadyEfficient !== false;
        let copyOut: string | null = null;
        if (guardApplies) {
          const copyDecision: Decision = { ...d, verdict: "copy", reason: "undersized" };
          copyOut = outputPathFor(copyDecision, sourceRoot, destination, policy);
          expected.add(pathKey(path.resolve(copyOut)));
        }

        if (copyOut && (!allPresent || anyStale)) {
          try {
            const st = await stat(copyOut);
            if (st.size > 0 && st.mtimeMs + 1000 >= d.file.mtime) {
              allPresent = true;
              anyStale = false;
              outBytes = st.size;
              reason = undefined;
              matchedOut = copyOut;
            }
          } catch {
            /* no copy fallback */
          }
        }

        const state: SyncState = !allPresent
          ? anyStale ? "changed" : "new"
          : "upToDate";

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

  // Orphans: anything sitting in the destination that we did not just expect.
  // Reported for visibility only - this tool never removes user data.
  const orphans: { out: string; bytes: number }[] = [];
  let orphanBytes = 0;
  async function walk(dir: string) {
    let entriesIn;
    try { entriesIn = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entriesIn) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(full); continue; }
      if (!e.isFile()) continue;
      if (e.name.startsWith(".picmagic-manifest-") || e.name.startsWith(".compakta-manifest-")) continue;
      if (e.name.includes(".part")) continue;
      // In merge mode, video files sharing the photo destination tree are not
      // photo orphans. Use the full list, not a hardcoded subset.
      if (VIDEO_EXT_SET.has(extOf(e.name))) continue;
      if (expected.has(pathKey(path.resolve(full)))) continue;
      try {
        const st = await stat(full);
        orphans.push({ out: full, bytes: st.size });
        orphanBytes += st.size;
      } catch { /* raced */ }
    }
  }
  await walk(destination);

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

/** Keeps only the decisions that still need work. */
export function pendingOnly(decisions: Decision[], report: SyncReport): Decision[] {
  const pending = new Set(
    report.entries.filter((e) => e.state !== "upToDate").map((e) => e.rel),
  );
  return decisions.filter((d) => pending.has(d.file.rel));
}

export type CleanOrphansResult = {
  removed: number;
  bytesFreed: number;
  refused: number;
  errors: string[];
};

/**
 * Deletes only orphan files verified to sit strictly inside `destination`.
 * Never touches manifest files or paths outside `destination`.
 */
export async function cleanOrphans(
  destination: string,
  orphans: { out: string; bytes: number }[],
): Promise<CleanOrphansResult> {
  const { rm, rmdir } = await import("node:fs/promises");
  const resolvedDest = path.resolve(destination);
  const destRoot = pathKey(resolvedDest);
  const res: CleanOrphansResult = { removed: 0, bytesFreed: 0, refused: 0, errors: [] };
  const candidateDirs = new Set<string>();

  for (const item of orphans) {
    const target = path.resolve(item.out);
    const base = path.basename(target);
    if (
      !pathKey(target).startsWith(destRoot + path.sep) ||
      base.startsWith(".compakta-manifest-") ||
      base.startsWith(".picmagic-manifest-")
    ) {
      res.refused++;
      continue;
    }
    try {
      await rm(target, { force: true });
      res.removed++;
      res.bytesFreed += item.bytes;
      let dir = path.dirname(target);
      while (pathKey(dir).startsWith(destRoot + path.sep)) {
        candidateDirs.add(dir);
        dir = path.dirname(dir);
      }
    } catch (err) {
      res.errors.push(`${target}: ${(err as Error).message}`);
    }
  }

  const sortedDirs = [...candidateDirs].sort((a, b) => b.length - a.length);
  for (const dir of sortedDirs) {
    await rmdir(dir).catch(() => {});
  }

  return res;
}