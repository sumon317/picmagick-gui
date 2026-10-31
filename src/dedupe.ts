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
  durationMs: number;
};

const CHUNK_BYTES = 64 * 1024;
const PARTIAL_THRESHOLD = CHUNK_BYTES * 4; // 256 KB

async function partialHashFile(abs: string, size: number): Promise<string> {
  if (size <= PARTIAL_THRESHOLD) return fullHashFile(abs);
  const fh = await open(abs, "r");
  try {
    const buf = Buffer.allocUnsafe(CHUNK_BYTES);
    const h = createHash("md5");
    const offsets = [0, Math.floor(size / 2) - Math.floor(CHUNK_BYTES / 2), size - CHUNK_BYTES];
    for (const offset of offsets) {
      const { bytesRead } = await fh.read(buf, 0, CHUNK_BYTES, Math.max(0, offset));
      h.update(buf.subarray(0, bytesRead));
    }
    return h.digest("hex");
  } finally {
    await fh.close();
  }
}

function fullHashFile(abs: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("md5");
    const s = createReadStream(abs);
    s.on("data", (c) => h.update(c));
    s.on("error", reject);
    s.on("end", () => resolve(h.digest("hex")));
  });
}

/** Cheap pre-pass: only files sharing a byte size can possibly collide. */
export function candidatesBySize(files: ScannedFile[], policy: Policy): ScannedFile[] {
  const out: ScannedFile[] = [];
  const bySize = new Map<number, ScannedFile[]>();
  for (const f of files) {
    if (classify(f, policy).verdict === "skip") continue;
    if (f.size === 0) continue;
    const arr = bySize.get(f.size);
    if (arr) arr.push(f);
    else bySize.set(f.size, [f]);
  }
  for (const [, arr] of bySize) if (arr.length > 1) out.push(...arr);
  return out;
}

export async function findDuplicates(
  files: ScannedFile[],
  policy: Policy,
  opts: { maxHash?: number; signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {},
): Promise<DedupeResult> {
  const started = Date.now();
  const maxHash = opts.maxHash ?? 40_000;
  const cands = candidatesBySize(files, policy).slice(0, maxHash);

  const CONC = 8;
  const partialGroups = new Map<string, ScannedFile[]>();
  let cursor = 0;

  // Stage 1: Fast partial fingerprint (or full hash if <= 256 KB)
  await Promise.all(
    Array.from({ length: CONC }, async () => {
      while (cursor < cands.length) {
        if (opts.signal?.aborted) return;
        const f = cands[cursor++];
        try {
          const pHash = await partialHashFile(f.abs, f.size);
          const key = `${f.size}:${pHash}`;
          const arr = partialGroups.get(key);
          if (arr) arr.push(f);
          else partialGroups.set(key, [f]);
        } catch {
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
          const hash = await fullHashFile(f.abs);
          hashedFiles++;
          hashedBytes += f.size;
          const arr = hashes.get(hash);
          if (arr) arr.push(f);
          else hashes.set(hash, [f]);
          opts.onProgress?.(hashedFiles, needFullHash.length);
        } catch {
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

  return {
    groups,
    duplicateFiles,
    duplicateBytes,
    hashedFiles,
    hashedBytes,
    durationMs: Date.now() - started,
  };
}
