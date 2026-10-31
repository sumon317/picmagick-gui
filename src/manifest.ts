/**
 * Run manifests: what we wrote, so it can be undone precisely.
 *
 * Nothing here ever deletes a file the run did not create. The undo path only
 * considers paths listed in a manifest, and refuses any path outside the
 * destination it was recorded against.
 */
import { writeFile, readFile, rm, rmdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { FileResult } from "./convert.ts";
import { pathKey } from "./platform.ts";
import type { OutputFormat } from "./formats.ts";

export type ManifestEntry = {
  out: string;
  src: string;
  status: FileResult["status"];
  bytes: number;
  at: number;
};

export type Manifest = {
  id: string;
  createdAt: number;
  sourceRoot: string;
  destination: string;
  quality: number[];
  heicSpeed: number;
  /** Missing in manifests written before format selection; treat as AVIF. */
  outputFormat?: OutputFormat;
  tool: string;
  entries: ManifestEntry[];
  summary: {
    converted: number;
    copied: number;
    skipped: number;
    failed: number;
    bytes: number;
  };
};

export function manifestPath(destination: string, id: string): string {
  // Check if a legacy manifest exists first for existing recorded runs
  const legacy = path.join(destination, `.picmagic-manifest-${id}.json`);
  if (existsSync(legacy)) return legacy;
  return path.join(destination, `.compakta-manifest-${id}.json`);
}

export async function writeManifest(
  destination: string,
  id: string,
  base: Omit<Manifest, "entries" | "summary" | "id">,
  results: FileResult[],
): Promise<Manifest> {
  const entries: ManifestEntry[] = results
    .filter((r) => r.out && (r.status === "converted" || r.status === "copied"))
    .map((r) => ({ out: r.out!, src: r.src, status: r.status, bytes: r.outBytes, at: Date.now() }));

  const manifest: Manifest = {
    ...base,
    id,
    entries,
    summary: {
      converted: results.filter((r) => r.status === "converted").length,
      copied: results.filter((r) => r.status === "copied").length,
      skipped: results.filter((r) => r.status === "skipped").length,
      failed: results.filter((r) => r.status === "failed").length,
      bytes: results.reduce((a, r) => a + r.outBytes, 0),
    },
  };

  await writeFile(manifestPath(destination, id), JSON.stringify(manifest, null, 2), "utf8");
  return manifest;
}

export async function readManifest(file: string): Promise<Manifest> {
  return JSON.parse(await readFile(file, "utf8")) as Manifest;
}

export async function listManifests(destination: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  if (!existsSync(destination)) return [];
  const entries = await readdir(destination);
  return entries.filter(
    (e) => (e.startsWith(".compakta-manifest-") || e.startsWith(".picmagic-manifest-")) && e.endsWith(".json"),
  );
}

export type UndoResult = {
  removed: number;
  missing: number;
  bytesFreed: number;
  refused: number;
  errors: string[];
};

/**
 * Deletes only the exact paths the manifest recorded. Anything resolving
 * outside the manifest's own destination is refused rather than deleted.
 */
export async function undoManifest(
  manifest: Manifest,
  opts: { dryRun?: boolean } = {},
): Promise<UndoResult> {
  const destRoot = pathKey(path.resolve(manifest.destination));
  const res: UndoResult = { removed: 0, missing: 0, bytesFreed: 0, refused: 0, errors: [] };
  const candidateDirs = new Set<string>();

  for (const e of manifest.entries) {
    const target = path.resolve(e.out);
    if (!pathKey(target).startsWith(destRoot + path.sep)) {
      res.refused++;
      continue;
    }
    if (!existsSync(target)) {
      res.missing++;
      continue;
    }
    res.bytesFreed += e.bytes;
    if (!opts.dryRun) {
      try {
        await rm(target, { force: true });
        res.removed++;
        let dir = path.dirname(target);
        while (pathKey(dir).startsWith(destRoot + path.sep)) {
          candidateDirs.add(dir);
          dir = path.dirname(dir);
        }
      } catch (err) {
        res.errors.push(`${target}: ${(err as Error).message}`);
      }
    } else {
      res.removed++;
    }
  }

  if (!opts.dryRun) {
    // Prune empty directories deepest-first; rmdir fails harmlessly if non-empty.
    const depth = (dir: string) => dir.split(path.sep).length;
    const sortedDirs = [...candidateDirs].sort((a, b) => depth(b) - depth(a));
    for (const dir of sortedDirs) {
      await rmdir(dir).catch(() => {});
    }

    await rm(manifestPath(manifest.destination, manifest.id), { force: true }).catch(() => {});
    await rm(path.join(manifest.destination, `.compakta-manifest-${manifest.id}.json`), { force: true }).catch(() => {});
    await rm(path.join(manifest.destination, `.picmagic-manifest-${manifest.id}.json`), { force: true }).catch(() => {});
  }
  return res;
}