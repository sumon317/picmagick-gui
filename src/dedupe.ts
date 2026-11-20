/**
 * Content-hash duplicate detection.
 *
 * Uses a three-tier pipeline so multi-gigabyte video and RAW libraries scan fast:
 *   1. Group by exact byte size.
 *   2. For files > 256 KB, hash a 192 KB fingerprint (first, middle, last 64 KB).
 *   3. Stream-hash full MD5 only on candidates whose partial fingerprints collide.
 */
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { ScannedFile } from "./scan.ts";
import type { Policy } from "./policy.ts";
import { classify } from "./policy.ts";
import { relTop } from "./platform.ts";

export type DuplicateGroup = {
  hash: string;
  size: number;
  members: { rel: string; abs: string; size: number; category: string }[];
  /** True when members live under more than one top-level folder. */
  spreadAcrossFolders: boolean;
};

export type DedupeResult = {
  groups: DuplicateGroup[];
  duplicateFiles: number;
  duplicateBytes: number;
  hashedFiles: number;
  hashedBytes: number;
  /** Candidates that could not be read (deleted since scan, locked, corrupt,
   * permission). Silent drops would make "no duplicates" look complete. */
  hashErrors: number;
  /** Same-size candidate groups with at least one file that failed hashing —
   * these could hide undetected duplicates, so they are reported, not dropped. */
  unhashedGroups: number;
  durationMs: number;
  truncated: boolean;
  candidateCount: number;
};

const CHUNK_BYTES = 64 * 1024;
const PARTIAL_THRESHOLD = CHUNK_BYTES * 4; // 256 KB

async function partialHashFile(abs: string, size: number, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new Error("aborted");
  if (size <= PARTIAL_THRESHOLD) return fullHashFile(abs, signal);
  const fh = await open(abs, "r");
  try {
    const buf = Buffer.allocUnsafe(CHUNK_BYTES);
    const h = createHash("md5");
    const offsets = [0, Math.floor(size / 2) - Math.floor(CHUNK_BYTES / 2), size - CHUNK_BYTES];
    for (const offset of offsets) {
      if (signal?.aborted) throw new Error("aborted");
      const { bytesRead } = await fh.read(buf, 0, CHUNK_BYTES, Math.max(0, offset));
      h.update(buf.subarray(0, bytesRead));
    }
    return h.digest("hex");
  } finally {
    await fh.close();
  }
}

function fullHashFile(abs: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const h = createHash("md5");
    const s = createReadStream(abs, { highWaterMark: 256 * 1024 });
    const onAbort = () => { s.destroy(new Error("aborted")); };
    signal?.addEventListener("abort", onAbort, { once: true });
    s.on("data", (c) => h.update(c));
    s.on("error", (err) => { signal?.removeEventListener("abort", onAbort); reject(err); });
    s.on("end", () => { signal?.removeEventListener("abort", onAbort); resolve(h.digest("hex")); });
  });
}

/** Cheap pre-pass: only files sharing a byte size can possibly collide. */
export function candidatesBySize(files: ScannedFile[], policy: Policy): ScannedFile[] {
  const out: ScannedFile[] = [];
  for (const group of candidateGroupsBySize(files, policy)) out.push(...group);
  return out;
}

function candidateGroupsBySize(files: ScannedFile[], policy: Policy): ScannedFile[][] {
  const bySize = new Map<number, ScannedFile[]>();
  for (const f of files) {
    if (classify(f, policy).verdict === "skip") continue;
    if (f.size === 0) continue;
    const arr = bySize.get(f.size);
    if (arr) arr.push(f);
    else bySize.set(f.size, [f]);
  }
  const groups: ScannedFile[][] = [];
  for (const arr of bySize.values()) if (arr.length > 1) groups.push(arr);
  return groups;
}

export async function findDuplicates(
  files: ScannedFile[],
  policy: Policy,
  opts: { maxHash?: number; signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {},
): Promise<DedupeResult> {
  const started = Date.now();
  const maxHash = opts.maxHash ?? 40_000;
  const groupsBySize = candidateGroupsBySize(files, policy);
  const totalCandidates = groupsBySize.reduce((sum, g) => sum + g.length, 0);
  // Keep whole same-size groups together so a duplicate pair is never split
  // across the maxHash cap.
  const cands: ScannedFile[] = [];
  for (const group of groupsBySize) {
    if (cands.length > 0 && cands.length + group.length > maxHash) break;
    cands.push(...group);
    if (cands.length >= maxHash) break;
  }
  const truncated = cands.length < totalCandidates;

  const CONC = 8;
  const partialGroups = new Map<string, ScannedFile[]>();
  let hashErrors = 0;
  // D-2: track exactly which candidates failed hashing so we can derive a real
  // count of unverified same-size groups instead of fabricating a number.
  const failedHashAbs = new Set<string>();
  let cursor = 0;

  // Stage 1: Fast partial fingerprint (or full hash if <= 256 KB)
  await Promise.all(
    Array.from({ length: CONC }, async () => {
      while (cursor < cands.length) {
        if (opts.signal?.aborted) return;
        const f = cands[cursor++];
        try {
          const pHash = await partialHashFile(f.abs, f.size, opts.signal);
          const key = `${f.size}:${pHash}`;
          const arr = partialGroups.get(key);
          if (arr) arr.push(f);
          else partialGroups.set(key, [f]);
        } catch {
          // A read failure is a real error unless the user aborted mid-hash -
          // abort tears (ENOENT/EBADF from a killed read) are not user-visible
          // problems and must not be counted.
          if (!opts.signal?.aborted) {
            hashErrors++;
            failedHashAbs.add(f.abs);
          }
          continue;
        }
      }
    }),
  );

  // Stage 2: Full MD5 stream only for files whose partial fingerprints collided
  const hashes = new Map<string, ScannedFile[]>();
  const needFullHash: ScannedFile[] = [];
  let hashedFiles = 0;
  let hashedBytes = 0;

  for (const [key, members] of partialGroups) {
    if (members.length < 2) continue;
    if (members[0].size <= PARTIAL_THRESHOLD) {
      // Partial hash already read the entire file
      const md5 = key.slice(key.indexOf(":") + 1);
      hashes.set(md5, members);
      hashedFiles += members.length;
      hashedBytes += members[0].size * members.length;
    } else {
      needFullHash.push(...members);
    }
  }

  let fullCursor = 0;
  await Promise.all(
    Array.from({ length: CONC }, async () => {
      while (fullCursor < needFullHash.length) {
        if (opts.signal?.aborted) return;
        const f = needFullHash[fullCursor++];
        try {
          const hash = await fullHashFile(f.abs, opts.signal);
          hashedFiles++;
          hashedBytes += f.size;
          const arr = hashes.get(hash);
          if (arr) arr.push(f);
          else hashes.set(hash, [f]);
          opts.onProgress?.(hashedFiles, needFullHash.length);
        } catch {
          if (!opts.signal?.aborted) {
            hashErrors++;
            failedHashAbs.add(f.abs);
          }
          continue;
        }
      }
    }),
  );

  const groups: DuplicateGroup[] = [];
  let duplicateFiles = 0;
  let duplicateBytes = 0;

  for (const [hash, members] of hashes) {
    if (members.length < 2) continue;
    const size = members[0].size;
    const rels = members.map((m) => m.rel);
    const folders = new Set(rels.map((r) => relTop(r)));
    groups.push({
      hash,
      size,
      members: members.map((m) => ({
        rel: m.rel,
        abs: m.abs,
        size: m.size,
        category: m.category,
      })),
      spreadAcrossFolders: folders.size > 1,
    });
    duplicateFiles += members.length;
    duplicateBytes += size * (members.length - 1);
  }

  groups.sort((a, b) => b.size * (b.members.length - 1) - a.size * (a.members.length - 1));

  // D-2: a same-size candidate bucket that lost a file to a hash error is not
  // a trustworthy "no duplicates here" result — it may hide a duplicate pair.
  // Count those buckets from the recorded failures (never fabricate a value).
  let unhashedGroups = 0;
  if (failedHashAbs.size > 0) {
    for (const members of groupsBySize) {
      if (members.some((m) => failedHashAbs.has(m.abs))) unhashedGroups++;
    }
  }

  return {
    groups,
    duplicateFiles,
    duplicateBytes,
    hashedFiles,
    hashedBytes,
    hashErrors,
    unhashedGroups,
    durationMs: Date.now() - started,
    truncated,
    candidateCount: totalCandidates,
  };
}
