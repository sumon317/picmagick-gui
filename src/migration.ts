/**
 * Migration helper for upgrading from legacy picmagick-gui to Compakta.
 *
 * Ensures existing users do not lose downloaded ImageMagick or FFmpeg binaries,
 * or existing undo manifests, when the app data path changes to Compakta.
 *
 * Safety posture (MIG-1): legacy BINARIES are never copied on faith of their
 * file name. Before a candidate toolchain directory is migrated, one of its
 * executables must prove its identity by answering `-version` with the
 * expected tool banner ("ImageMagick" / "ffmpeg version"). A candidate that
 * cannot (renamed payload, corrupted download, attacker-planted file) is
 * skipped, and the summary carries an integrityNote instead. The banner is
 * not a cryptographic guarantee, but it stops the blind "whatever file sits
 * at imagemagick/ gets executed by the app" promotion; the app's own
 * installer verifies its downloads by digest, so re-downloading from the
 * installer remains the fully verified path.
 *
 * Boot posture (MIG-2): the whole migration is async (fs/promises) and keeps
 * a module-level in-flight promise; repeated callers share one run instead of
 * racing two copiers. Wire it fire-and-forget at boot WITH a rejection guard,
 * exactly as desktop.ts:99 already does:
 *   void migrateLegacyData(DATA_DIR, legacyCandidates).catch(err =>
 *     console.warn("[compakta] Startup legacy data migration notice:", err));
 */
import { access, mkdir, readdir, readFile, cp } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { pathKey } from "./platform.ts";
import { compareVersions } from "./version.ts";

export type MigrationSummary = {
  migratedMagick: boolean;
  migratedFfmpeg: boolean;
  migratedManifests: number;
  /** Set when a candidate toolchain was found but NOT migrated because it
   * could not prove its identity - contains the skip reasons. */
  integrityNote?: string;
};

/**
 * Returns candidate directory paths where older picmagick-gui releases
 * stored user state on Windows and Linux/macOS.
 */
export function getLegacyDataCandidates(appDataRoot?: string): string[] {
  const roaming = appDataRoot || process.env.APPDATA || "";
  const local = process.env.LOCALAPPDATA || "";
  const home = process.env.HOME || process.env.USERPROFILE || "";

  const candidates: string[] = [];

  if (roaming) {
    candidates.push(path.join(roaming, "picmagick-gui"));
    candidates.push(path.join(roaming, "PicMagick GUI"));
    for (const ch of ["stable", "canary"]) {
      candidates.push(path.join(roaming, "com.github.esconer.picmagick-gui", ch));
    }
  }
  if (local) {
    candidates.push(path.join(local, "picmagick-gui"));
    candidates.push(path.join(local, "PicMagick GUI"));
    candidates.push(path.join(local, "com.github.esconer.picmagick-gui"));
    for (const ch of ["stable", "canary"]) {
      candidates.push(path.join(local, "com.github.esconer.picmagick-gui", ch));
    }
  }
  if (home) {
    candidates.push(path.join(home, ".config", "picmagick-gui"));
    candidates.push(path.join(home, ".config", "PicMagick GUI"));
    candidates.push(path.join(home, ".local", "share", "picmagick-gui"));
    candidates.push(path.join(home, ".local", "share", "PicMagick GUI"));
    for (const ch of ["stable", "canary"]) {
      candidates.push(path.join(home, ".local", "share", "com.github.esconer.picmagick-gui", ch));
    }
    candidates.push(path.join(home, "Library", "Application Support", "picmagick-gui"));
    candidates.push(path.join(home, "Library", "Application Support", "PicMagick GUI"));
  }

  // De-duplicate paths
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const c of candidates) {
    const norm = pathKey(path.resolve(c));
    if (!seen.has(norm)) {
      seen.add(norm);
      unique.push(c);
    }
  }

  return unique;
}

/** Run `exe -version` and require the expected banner in the output.
 * 10 s cap; any failure (missing, hang, wrong tool) is a veto. */
function versionProbe(exe: string, expect: RegExp): Promise<boolean> {
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      try { c?.kill(); } catch { /* already gone */ }
      done(false);
    }, 10_000);
    // A corrupt/impostor exe can make spawn throw SYNCHRONOUSLY (observed on
    // Windows/Bun: EUNKNOWN uv_spawn, errno -4094) instead of emitting an
    // "error" event. Without this catch the throw escapes the veto semantics,
    // aborts the whole candidate's migration (manifests included) and loses
    // the integrity note.
    let c: ChildProcess | undefined;
    try {
      const env = /\.appimage$/i.test(exe)
        ? { ...process.env, APPIMAGE_EXTRACT_AND_RUN: "1" }
        : process.env;
      c = spawn(exe, ["-version"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env });
    } catch {
      done(false);
      return;
    }
    c.stdout?.on("data", (d) => { if (out.length < 4000) out += String(d); });
    c.on("error", () => done(false));
    c.on("close", () => done(expect.test(out)));
  });
}

/**
 * Find a toolchain binary underneath `dir`, searching a bounded depth.
 *
 * The legacy layout is NOT flat: the updater installs ImageMagick into
 * `<dir>/ImageMagick-<ver>-portable-Q16-<arch>/magick.exe` and records the
 * chosen folder in `current.txt` (imagemagick.ts:536-537). `findMagick()`
 * (paths.ts:projectMagickCandidates) prefers that pointer, then the folder
 * root, then versioned subfolders newest first. A top-level-only scan skipped
 * every such install and silently lost the user's bundled toolchain.
 *
 * Search order mirrors findMagick (first match wins):
 *   1. the folder named by current.txt (only if it resolves inside `dir`),
 *   2. `dir` itself,
 *   3. subdirectories breadth-first, versioned names newest first, each
 *      scanned to at most MAX_DEPTH levels below `dir`.
 *
 * Safety: symlinks/junctions are never followed (so loops are impossible),
 * a visited-key set deduplicates aliases, and every readdir result is sorted
 * so the chosen binary is deterministic across platforms/filesystems. Depth
 * is bounded so an arbitrary legacy tree cannot turn boot migration into a
 * deep unbounded walk.
 */
async function findBinariesAt(dir: string, re: RegExp): Promise<string[]> {
  const MAX_DEPTH = 3;
  const found: string[] = [];
  const seenFiles = new Set<string>();

  const pushFilesIn = async (d: string): Promise<void> => {
    let list;
    try { list = await readdir(d, { withFileTypes: true }); } catch { return; }
    list.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of list) {
      if (e.isFile() && re.test(e.name)) {
        const full = path.join(d, e.name);
        const key = pathKey(path.resolve(full));
        if (!seenFiles.has(key)) {
          seenFiles.add(key);
          found.push(full);
        }
      }
    }
  };

  // 1. current.txt pointer - the folder findMagick tries first.
  try {
    const raw = (await readFile(path.join(dir, "current.txt"), "utf8")).trim();
    const pointer = raw.replace(/^["']|["']$/g, "");
    if (pointer && !path.isAbsolute(pointer)) {
      const target = path.resolve(dir, pointer);
      const dirKey = pathKey(path.resolve(dir));
      const dirPrefix = dirKey.endsWith(path.sep) ? dirKey : dirKey + path.sep;
      // current.txt is app-written, but never let it point outside the folder.
      if (pathKey(target).startsWith(dirPrefix)) {
        await pushFilesIn(target);
      }
    }
  } catch { /* no pointer (or unreadable) - fall through to the normal scan */ }

  // 2. Breadth-first: check files at a level before descending into its folders.
  const visited = new Set<string>([pathKey(path.resolve(dir))]);
  const queue: { dir: string; depth: number }[] = [{ dir, depth: 0 }];
  while (queue.length > 0) {
    const { dir: here, depth } = queue.shift()!;
    let list;
    try { list = await readdir(here, { withFileTypes: true }); } catch { continue; }
    list.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of list) {
      if (e.isFile() && re.test(e.name)) {
        const full = path.join(here, e.name);
        const key = pathKey(path.resolve(full));
        if (!seenFiles.has(key)) {
          seenFiles.add(key);
          found.push(full);
        }
      }
    }
    if (depth >= MAX_DEPTH) continue;
    const folders = list.filter((e) => e.isDirectory()).map((e) => e.name);
    // Version dirs newest first, then plain alphabetical - same as paths.ts.
    folders.sort((a, b) => compareVersions(b, a) || b.localeCompare(a));
    for (const name of folders) {
      const sub = path.join(here, name);
      const key = pathKey(path.resolve(sub));
      if (visited.has(key)) continue;
      visited.add(key);
      queue.push({ dir: sub, depth: depth + 1 });
    }
  }
  return found;
}

async function dirNonEmpty(dir: string): Promise<boolean> {
  try {
    const list = await readdir(dir);
    return list.length > 0;
  } catch {
    return false;
  }
}

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

/** Migrate one toolchain directory (magick/ffmpeg).
 * "migrated": verified copy done. "noop": nothing to do (absent or already
 * present). Otherwise a skip reason for the integrity note. */
async function migrateToolchain(
  legacyDir: string,
  targetDir: string,
  binaryName: RegExp,
  binaryLabel: string,
  banner: RegExp,
  label: string,
  integrityCheck: boolean,
): Promise<"migrated" | "noop" | string> {
  if (!(await dirNonEmpty(legacyDir))) return "noop"; // nothing to migrate
  if (await dirNonEmpty(targetDir)) return "noop";    // already present
  if (!integrityCheck) {
    await mkdir(targetDir, { recursive: true });
    await cp(legacyDir, targetDir, { recursive: true });
    console.log(`[compakta] Migrated ${label} from ${legacyDir} -> ${targetDir} (integrity check bypassed)`);
    return "migrated";
  }
  const binaries = await findBinariesAt(legacyDir, binaryName);
  if (binaries.length === 0) {
    return `${label}: no ${binaryLabel} inside ${legacyDir} - skipped (integrity check)`;
  }
  for (const binary of binaries) {
    if (await versionProbe(binary, banner)) {
      await mkdir(targetDir, { recursive: true });
      await cp(legacyDir, targetDir, { recursive: true });
      console.log(`[compakta] Migrated ${label} from ${legacyDir} -> ${targetDir}`);
      return "migrated";
    }
  }
  return `${label}: binary at ${binaries[0]} failed the ${label} -version check - skipped (integrity check)`;
}

// MIG-2: share one migration run between concurrent callers instead of
// letting two copiers race for the same target directories.
let inFlight: Promise<MigrationSummary> | null = null;

/**
 * Migrate legacy managed binaries and manifests into targetDir if targetDir
 * does not already have them. Async and self-locking; call as
 * `void migrateLegacyData(...)` at boot.
 */
export function migrateLegacyData(
  targetDir: string,
  candidateDirs?: string[],
  opts: { integrityCheck?: boolean } = {},
): Promise<MigrationSummary> {
  if (inFlight) return inFlight;
  const integrityCheck = opts.integrityCheck !== false;
  inFlight = migrateLegacyDataInner(targetDir, candidateDirs, integrityCheck)
    .finally(() => { inFlight = null; });
  return inFlight;
}

async function migrateLegacyDataInner(
  targetDir: string,
  candidateDirs?: string[],
  integrityCheck = true,
): Promise<MigrationSummary> {
  const candidates = candidateDirs ?? getLegacyDataCandidates();
  const summary: MigrationSummary = {
    migratedMagick: false,
    migratedFfmpeg: false,
    migratedManifests: 0,
  };
  const integritySkips: string[] = [];

  const resolvedTarget = path.resolve(targetDir);

  for (const candidate of candidates) {
    if (!candidate || !(await exists(candidate))) continue;
    if (pathKey(path.resolve(candidate)) === pathKey(resolvedTarget)) continue;

    try {
      // 1. ImageMagick
      const result = await migrateToolchain(
        path.join(candidate, "imagemagick"),
        path.join(targetDir, "imagemagick"),
        /^(?:magick\d*(?:\.exe)?|ImageMagick.*\.AppImage)$/i,
        "magick[0-9]*(.exe)? or ImageMagick*.AppImage",
        /ImageMagick/i,
        "ImageMagick",
        integrityCheck,
      );
      // "migrated"/"noop" are strings too - the sentinels are checked FIRST,
      // otherwise the skip-reason branch swallows them and the summary flags
      // can never become true (found by probe: success returned
      // migratedMagick=false even after a verified copy).
      if (result === "migrated") summary.migratedMagick = true;
      else if (result !== "noop") integritySkips.push(result);

      // 2. FFmpeg
      const result2 = await migrateToolchain(
        path.join(candidate, "ffmpeg"),
        path.join(targetDir, "ffmpeg"),
        /^ffmpeg(\.exe)?$/i,
        "ffmpeg(.exe)?",
        /ffmpeg version/i,
        "FFmpeg",
        integrityCheck,
      );
      if (result2 === "migrated") summary.migratedFfmpeg = true;
      else if (result2 !== "noop") integritySkips.push(result2);

      // 3. Manifests subdirectory if present - JSON data, not code; copy as-is.
      const oldManifestsDir = path.join(candidate, "manifests");
      const targetManifestsDir = path.join(targetDir, "manifests");
      if (await exists(oldManifestsDir)) {
        await mkdir(targetManifestsDir, { recursive: true });
        const list = await readdir(oldManifestsDir);
        for (const item of list) {
          const srcItem = path.join(oldManifestsDir, item);
          const dstItem = path.join(targetManifestsDir, item);
          if (!(await exists(dstItem))) {
            await cp(srcItem, dstItem, { recursive: true });
            summary.migratedManifests++;
          }
        }
      }

      // 4. Loose manifest JSON files in root of candidate - same as (3); each
      // is read before copy so invalid payloads never reach the app's undo path.
      const entries = await readdir(candidate, { withFileTypes: true });
      for (const ent of entries) {
        if (
          ent.isFile() &&
          (ent.name.startsWith(".picmagic-manifest-") || ent.name.startsWith(".compakta-manifest-"))
        ) {
          const srcFile = path.join(candidate, ent.name);
          const dstFile = path.join(targetDir, ent.name);
          if (!(await exists(dstFile))) {
            try {
              JSON.parse(await readFile(srcFile, "utf8"));
            } catch {
              integritySkips.push(`manifest ${ent.name} is not valid JSON - skipped`);
              continue;
            }
            await cp(srcFile, dstFile);
            summary.migratedManifests++;
          }
        }
      }
    } catch (err) {
      console.warn(`[compakta] Notice: Legacy data migration check for ${candidate} had error:`, err);
    }
  }

  if (integritySkips.length > 0) {
    summary.integrityNote = integritySkips.join("; ");
    console.warn(`[compakta] ${summary.integrityNote}. Re-download the toolchain from the Compakta installer for the verified path.`);
  }

  return summary;
}
