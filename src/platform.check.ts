/**
 * Platform path checks, run on both windows-latest and ubuntu-latest.
 *
 * These encode the behaviour Windows had before Linux support: native
 * backslash relative paths, case-insensitive matching, and prefix-safe
 * exclusions. A shared helper that changes any of that fails CI instead of
 * surprising a user.
 *
 *   bun run src/platform.check.ts
 */
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, utimes, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CASE_INSENSITIVE, IS_WINDOWS, REL_SEP, pathKey, relIsUnder, relTop,
} from "./platform.ts";
import { applyPolicy, DEFAULT_POLICY, outputPathFor, type Decision } from "./policy.ts";
import type { ScanResult, ScannedFile } from "./scan.ts";
import { undoManifest, type Manifest } from "./manifest.ts";
import { analyseSync } from "./sync.ts";
import { assertDestinationSafe, isAppImage } from "./paths.ts";
import {
  IMAGEMAGICK_ROOT, isManagedInstall, isTrustedReleaseUrl,
  pickAppImageAsset, pickPortableAsset,
} from "./imagemagick.ts";
import { pickLeanAppAsset } from "./app-update.ts";
import { runHealthCheck } from "./health.ts";
import { migrateLegacyData } from "./migration.ts";
import { calculateAffinityMask, applyProcessCpuLimit, suspendProcess, resumeProcess } from "./cpu.ts";
import { spawn } from "node:child_process";
import * as tree from "../src/client/tree-logic.ts";

let failures = 0;

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${(err as Error).message}`);
  }
}

const nativeRel = (...parts: string[]) => parts.join(REL_SEP);

function scanned(parts: string[], size = 2 * 1024 * 1024): ScannedFile {
  const rel = nativeRel(...parts);
  return {
    abs: path.resolve("/library", rel),
    rel,
    dir: path.dirname(rel),
    name: parts[parts.length - 1],
    ext: "jpg",
    size,
    category: "image",
    mtime: 0,
  };
}

console.log(`platform: ${process.platform}, separator: ${JSON.stringify(REL_SEP)}`);

await check("platform constants", () => {
  assert.equal(REL_SEP, IS_WINDOWS ? "\\" : "/");
  assert.equal(CASE_INSENSITIVE, IS_WINDOWS);
});

await check("splits both native path styles when asked", () => {
  assert.equal(relTop("album/2025/a.jpg", "/"), "album");
  assert.equal(relTop("album\\2025\\a.jpg", "\\"), "album");
});

await check("uses the platform separator by default", () => {
  assert.equal(relTop(nativeRel("album", "2025", "a.jpg")), "album");
});

await check("treats a literal backslash as a filename character on Linux", () => {
  if (IS_WINDOWS) {
    // A backslash cannot appear inside a filename on Windows, so there is
    // nothing to assert here; the Linux CI job runs the check below. The
    // early return keeps the skip explicit instead of a vacuous pass.
    console.log("  skip backslash-as-name assert (not representable on Windows)");
    return;
  }
  assert.equal(relTop("album\\november.jpg"), "album\\november.jpg");
});

await check("matches prefixes only on a path boundary", () => {
  assert.equal(relIsUnder("album/sub/a.jpg", "album", "/"), true);
  assert.equal(relIsUnder("album", "album", "/"), true);
  assert.equal(relIsUnder("albums/a.jpg", "album", "/"), false);
  assert.equal(relIsUnder("album2\\a.jpg", "album", "\\"), false);
});

await check("folds path case only on Windows", () => {
  assert.equal(pathKey("Album/Sub"), CASE_INSENSITIVE ? "album/sub" : "Album/Sub");
});

await check("groups by the platform top-level folder", () => {
  const scan = {
    files: [scanned(["album", "sub", "a.jpg"])],
  } as unknown as ScanResult;
  const preview = applyPolicy(scan, DEFAULT_POLICY);
  assert.equal(preview.byFolder.length, 1);
  assert.equal(preview.byFolder[0].rel, "album");
});

await check("file selections override folder selections", () => {
  const inside = scanned(["album", "sub", "a.jpg"]);
  const outside = scanned(["album", "other", "b.jpg"]);
  const scan = { files: [inside, outside] } as unknown as ScanResult;

  // An included file survives an excluded folder.
  let preview = applyPolicy(scan, {
    ...DEFAULT_POLICY,
    excludedFolders: [nativeRel("album")],
    includedFiles: [inside.rel],
  });
  assert.deepEqual(preview.convert.map((d) => d.file.rel), [inside.rel]);

  // An excluded file stays out even when its folder is included.
  preview = applyPolicy(scan, {
    ...DEFAULT_POLICY,
    includedFolders: [nativeRel("album")],
    excludedFiles: [outside.rel],
  });
  assert.deepEqual(preview.convert.map((d) => d.file.rel), [inside.rel]);
});

await check("builds native output paths", () => {
  const destination = path.resolve("platform-check-out");
  const decision: Decision = {
    file: scanned(["album", "sub", "a.jpg"]),
    verdict: "convert",
    reason: "ok",
  };
  assert.equal(
    outputPathFor(decision, "/source", destination, DEFAULT_POLICY),
    path.join(destination, nativeRel("album", "sub"), "a.avif"),
  );
});

await check("undo refuses paths outside the destination", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "picmagick-platform-"));
  try {
    const destination = path.join(root, "out");
    await mkdir(destination);
    const inside = path.join(destination, "a.avif");
    const outside = path.join(root, "outside.avif");
    await writeFile(inside, "x");
    await writeFile(outside, "x");

    const entry = (out: string): Manifest["entries"][number] => ({
      out, src: "/source/a.jpg", status: "converted", bytes: 1, at: 0,
    });
    const manifest: Manifest = {
      id: "platform-check",
      createdAt: 0,
      sourceRoot: path.join(root, "src"),
      destination,
      quality: [60],
      heicSpeed: 6,
      tool: "platform-check",
      entries: [entry(inside), entry(outside)],
      summary: { converted: 2, copied: 0, skipped: 0, failed: 0, bytes: 2 },
    };

    const result = await undoManifest(manifest, { dryRun: true });
    assert.equal(result.removed, 1);
    assert.equal(result.refused, 1);
    assert.equal(result.missing, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await check("undo case handling follows the platform", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "picmagick-platform-"));
  try {
    const destination = path.join(root, "out");
    await mkdir(destination);
    const inside = path.join(destination, "a.avif");
    await writeFile(inside, "x");

    const manifest: Manifest = {
      id: "platform-check",
      createdAt: 0,
      sourceRoot: path.join(root, "src"),
      destination: destination.toUpperCase(),
      quality: [60],
      heicSpeed: 6,
      tool: "platform-check",
      entries: [{
        out: inside, src: "/source/a.jpg", status: "converted", bytes: 1, at: 0,
      }],
      summary: { converted: 1, copied: 0, skipped: 0, failed: 0, bytes: 1 },
    };

    const result = await undoManifest(manifest, { dryRun: true });
    assert.equal(result.refused, CASE_INSENSITIVE ? 0 : 1);
    assert.equal(result.removed, CASE_INSENSITIVE ? 1 : 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await check("sync matches output case only on Windows", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "picmagick-platform-"));
  try {
    const source = path.join(root, "src");
    const destination = path.join(root, "out");
    const outDir = path.join(destination, "album");
    await mkdir(source);
    await mkdir(outDir, { recursive: true });

    // Deliberately wrong case. Windows must still find it; Linux must not.
    const output = path.join(outDir, "A.avif");
    await writeFile(output, "x");
    const now = new Date();
    await utimes(output, now, now);

    const decision: Decision = {
      file: scanned(["album", "a.jpg"]),
      verdict: "convert",
      reason: "ok",
    };
    const report = await analyseSync([decision], source, destination, DEFAULT_POLICY);
    assert.equal(report.entries[0].state, CASE_INSENSITIVE ? "upToDate" : "new");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const opts = { sep: REL_SEP, caseInsensitive: CASE_INSENSITIVE };
const ex = tree.excludedLower(new Set([nativeRel("album")]), CASE_INSENSITIVE);

await check("exclusion covers a folder and its descendants", () => {
  const child = CASE_INSENSITIVE
    ? nativeRel("ALBUM", "SUB", "a.jpg")
    : nativeRel("album", "sub", "a.jpg");
  assert.equal(tree.isFullyExcluded(child, ex, new Set(), opts), true);
  assert.equal(tree.isFullyExcluded(nativeRel("albums", "a.jpg"), ex, new Set(), opts), false);
});

await check("an include overrides an excluded ancestor", () => {
  const inc = tree.excludedLower(new Set([nativeRel("album", "sub")]), CASE_INSENSITIVE);
  assert.equal(
    tree.isFullyExcluded(nativeRel("album", "sub", "a.jpg"), ex, inc, opts),
    false,
  );
  assert.equal(
    tree.isFullyExcluded(nativeRel("album", "other", "a.jpg"), ex, inc, opts),
    true,
  );
});

await check("a descendant exclusion is visible to the tree", () => {
  const node = { rel: nativeRel("album"), children: [] };
  assert.equal(tree.hasExcludedDescendant(node, ex, new Set(), opts), true);
  const other = { rel: nativeRel("other"), children: [] };
  assert.equal(tree.hasExcludedDescendant(other, ex, new Set(), opts), false);
});

await check("toggling keeps ancestor exclusions and adds include overrides", () => {
  let r = tree.toggleFolder(null, new Set(), nativeRel("album"), true, new Set(), opts);
  assert.equal(r.excluded.size, 1);
  assert.equal(r.included.size, 0);

  r = tree.toggleFolder(null, r.excluded, nativeRel("album", "sub"), false, r.included, opts);
  assert.equal(r.excluded.size, 1);
  assert.equal(r.included.size, 1);

  r = tree.toggleFolder(null, r.excluded, nativeRel("album"), false, r.included, opts);
  assert.equal(r.excluded.size, 0);
  assert.equal(r.included.size, 0);
});

await check("file rules are more specific than folder rules", () => {
  const exFolders = tree.excludedLower(new Set([nativeRel("album")]), CASE_INSENSITIVE);
  const exFiles = tree.excludedLower(new Set([nativeRel("album", "sub", "a.jpg")]), CASE_INSENSITIVE);
  const incFiles = tree.excludedLower(new Set([nativeRel("album", "sub", "b.jpg")]), CASE_INSENSITIVE);

  // Explicit include survives the excluded folder.
  assert.equal(
    tree.isFileExcluded(nativeRel("album", "sub", "b.jpg"), exFolders, new Set(), exFiles, incFiles, opts),
    false,
  );
  // Explicit exclude stays out.
  assert.equal(
    tree.isFileExcluded(nativeRel("album", "sub", "a.jpg"), exFolders, new Set(), exFiles, incFiles, opts),
    true,
  );
  // No file rule: the folder exclusion still applies.
  assert.equal(
    tree.isFileExcluded(nativeRel("album", "sub", "c.jpg"), exFolders, new Set(), exFiles, incFiles, opts),
    true,
  );
});

await check("toggling one file clears its opposite rule", () => {
  let r = tree.toggleFile(nativeRel("album", "a.jpg"), true, new Set(), new Set(), opts);
  assert.equal(r.excludedFiles.size, 1);
  assert.equal(r.includedFiles.size, 0);

  r = tree.toggleFile(nativeRel("album", "a.jpg"), false, r.excludedFiles, r.includedFiles, opts);
  assert.equal(r.excludedFiles.size, 0);
  assert.equal(r.includedFiles.size, 1);
});

await check("folder toggles clear file overrides underneath", () => {
  const exFiles = new Set([nativeRel("album", "a.jpg"), nativeRel("other", "b.jpg")]);
  const incFiles = new Set([nativeRel("album", "sub", "c.jpg")]);
  const r = tree.clearFileOverridesUnder(nativeRel("album"), exFiles, incFiles, opts);
  assert.deepEqual([...r.excludedFiles], [nativeRel("other", "b.jpg")]);
  assert.equal(r.includedFiles.size, 0);
});

await check("selection counts cover nested files", () => {
  const node = {
    rel: nativeRel("album"),
    files: [scanned(["album", "a.jpg"]), scanned(["album", "b.jpg"])],
    children: [{
      rel: nativeRel("album", "sub"),
      files: [scanned(["album", "sub", "c.jpg"])],
      children: [],
    }],
  };
  const counts = new Map<string, { total: number; selected: number }>();
  const root = tree.countSelection(node, (f) => f.name !== "b.jpg", counts);
  assert.deepEqual(root, { total: 3, selected: 2 });
  assert.deepEqual(counts.get(nativeRel("album", "sub")), { total: 1, selected: 1 });
});

await check("tree logic also handles explicit Windows-style paths", () => {
  const windowsEx = new Set(["album"]);
  assert.equal(
    tree.isFullyExcluded("Album\\Sub\\a.jpg", windowsEx, new Set(), {
      sep: "\\", caseInsensitive: true,
    }),
    true,
  );
});

await check("tree logic handles exact-case Linux paths", () => {
  assert.equal(
    tree.isFullyExcluded("Album/Sub/a.jpg", new Set(["album"]), new Set(), {
      sep: "/", caseInsensitive: false,
    }),
    false,
  );
});

await check("recognises AppImage names case-insensitively", () => {
  assert.equal(isAppImage("/tmp/ImageMagick-7.1.2-34-gcc-x86_64.AppImage"), true);
  assert.equal(isAppImage("/tmp/ImageMagick-7.1.2-34-gcc-x86_64.appimage"), true);
  assert.equal(isAppImage("/tmp/magick"), false);
});

await check("prefers the gcc x86_64 AppImage", () => {
  const assets = [
    { name: "ImageMagick-7.1.2-34-clang-x86_64.AppImage", size: 2, browser_download_url: "https://github.com/a" },
    { name: "ImageMagick-7.1.2-34-gcc-x86_64.AppImage", size: 3, browser_download_url: "https://github.com/b", digest: "sha256:abc" },
  ];
  const picked = pickAppImageAsset(assets, "x64");
  assert.equal(picked?.name, "ImageMagick-7.1.2-34-gcc-x86_64.AppImage");
  assert.equal(picked?.size, 3);
  assert.equal(picked?.digest, "sha256:abc");
});

await check("falls back to the clang AppImage", () => {
  const picked = pickAppImageAsset([
    { name: "ImageMagick-7.1.2-34-clang-x86_64.AppImage", size: 2, browser_download_url: "https://github.com/a" },
  ], "x64");
  assert.equal(picked?.name, "ImageMagick-7.1.2-34-clang-x86_64.AppImage");
});

await check("AppImage selection rejects other architectures", () => {
  const assets = [
    { name: "ImageMagick-7.1.2-34-gcc-aarch64.AppImage", size: 2, browser_download_url: "https://github.com/a" },
  ];
  assert.equal(pickAppImageAsset(assets, "arm64"), null);
  assert.equal(pickAppImageAsset(assets, "x64"), null);
});

await check("portable selection still ignores the HDRI archive", () => {
  const assets = [
    { name: "ImageMagick-7.1.2-34-portable-Q16-HDRI-x64.7z", size: 2, browser_download_url: "https://github.com/a" },
    { name: "ImageMagick-7.1.2-34-portable-Q16-x64.7z", size: 3, browser_download_url: "https://github.com/b", digest: "sha256:def" },
  ];
  const picked = pickPortableAsset(assets, "x64");
  assert.equal(picked?.name, "ImageMagick-7.1.2-34-portable-Q16-x64.7z");
  assert.equal(picked?.digest, "sha256:def");
});

await check("trusts only official GitHub release URLs", () => {
  assert.equal(
    isTrustedReleaseUrl("https://github.com/ImageMagick/ImageMagick/releases/download/7.1.2-34/x.AppImage"),
    true,
  );
  assert.equal(
    isTrustedReleaseUrl("http://github.com/ImageMagick/ImageMagick/releases/download/7.1.2-34/x.AppImage"),
    false,
  );
  assert.equal(
    isTrustedReleaseUrl("https://github.com.evil.test/ImageMagick/ImageMagick/releases/download/x"),
    false,
  );
  assert.equal(
    isTrustedReleaseUrl("https://github.com/other/repo/releases/download/x"),
    false,
  );
});

await check("managed install detection stays inside the app folder", () => {
  assert.equal(isManagedInstall(path.join(IMAGEMAGICK_ROOT, "x", "magick.exe")), true);
  assert.equal(isManagedInstall(path.join(IMAGEMAGICK_ROOT, "..", "elsewhere", "magick")), false);
});

await check("calculates CPU affinity mask correctly for percentages", () => {
  assert.equal(calculateAffinityMask(70, 8), 0x1Fn);
  assert.equal(calculateAffinityMask(100, 8), 0xFFn);
  assert.equal(calculateAffinityMask(10, 8), 0x1n);
  assert.equal(calculateAffinityMask(50, 16), 0xFFn);
  assert.equal(calculateAffinityMask(70, 16), 0x7FFn);
});

await check("applies CPU limit dynamically to process", () => {
  const child = spawn(
    process.platform === "win32" ? "ping.exe" : "sleep",
    process.platform === "win32" ? ["-n", "4", "127.0.0.1"] : ["2"],
  );
  const ok1 = applyProcessCpuLimit(child.pid, 70);
  const ok2 = applyProcessCpuLimit(child.pid, 50);
  assert.equal(typeof ok1, "boolean");
  assert.equal(typeof ok2, "boolean");
  if (process.platform === "win32") {
    assert.equal(ok1, true);
    assert.equal(ok2, true);
  }
  child.kill();
});

await check("suspends and resumes process dynamically", () => {
  const child = spawn(
    process.platform === "win32" ? "ping.exe" : "sleep",
    process.platform === "win32" ? ["-n", "4", "127.0.0.1"] : ["2"],
  );
  const sOk = suspendProcess(child.pid);
  const rOk = resumeProcess(child.pid);
  assert.equal(typeof sOk, "boolean");
  assert.equal(typeof rOk, "boolean");
  if (process.platform === "win32") {
    assert.equal(sOk, true);
    assert.equal(rOk, true);
  }
  child.kill();
});

await check("app update picks the lean asset and prefers Compakta with PicMagick fallback", () => {
  const legacyAssets = [
    { name: "stable-win-x64-PicMagickGUI.tar.zst", size: 45000000, browser_download_url: "https://dl/zst" },
    { name: "stable-win-x64-update.json", size: 100, browser_download_url: "https://dl/json" },
    { name: "win-x64-PicMagickGUIFull-Setup.zip", size: 125000000, browser_download_url: "https://dl/win-full" },
    { name: "win-x64-PicMagickGUI-Setup.zip", size: 47000000, browser_download_url: "https://dl/win-legacy" },
    { name: "linux-x64-PicMagickGUIFull-Setup.tar.gz", size: 80000000, browser_download_url: "https://dl/lin-full" },
    { name: "linux-x64-PicMagickGUI-Setup.tar.gz", size: 49000000, browser_download_url: "https://dl/lin-legacy" },
  ];
  const legacyPicked = pickLeanAppAsset(legacyAssets);
  assert.ok(legacyPicked);
  if (IS_WINDOWS) {
    assert.equal(legacyPicked.name, "win-x64-PicMagickGUI-Setup.zip");
    assert.equal(legacyPicked.url, "https://dl/win-legacy");
  } else {
    assert.equal(legacyPicked.name, "linux-x64-PicMagickGUI-Setup.tar.gz");
    assert.equal(legacyPicked.url, "https://dl/lin-legacy");
  }

  const mixedAssets = [
    ...legacyAssets,
    { name: "win-x64-Compakta-Setup.zip", size: 46000000, browser_download_url: "https://dl/win-compakta" },
    { name: "linux-x64-Compakta-Setup.tar.gz", size: 48000000, browser_download_url: "https://dl/lin-compakta" },
  ];
  const compaktaPicked = pickLeanAppAsset(mixedAssets);
  assert.ok(compaktaPicked);
  if (IS_WINDOWS) {
    assert.equal(compaktaPicked.name, "win-x64-Compakta-Setup.zip");
    assert.equal(compaktaPicked.url, "https://dl/win-compakta");
  } else {
    assert.equal(compaktaPicked.name, "linux-x64-Compakta-Setup.tar.gz");
    assert.equal(compaktaPicked.url, "https://dl/lin-compakta");
  }
});

await check("migrateLegacyData copies ImageMagick, FFmpeg, and manifests from older AppData", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "compakta-migration-"));
  try {
    const legacyDir = path.join(root, "legacy-picmagick-gui");
    const targetDir = path.join(root, "Compakta");
    await mkdir(path.join(legacyDir, "imagemagick"), { recursive: true });
    await mkdir(path.join(legacyDir, "ffmpeg"), { recursive: true });
    await mkdir(path.join(legacyDir, "manifests"), { recursive: true });
    await mkdir(targetDir, { recursive: true });

    await writeFile(path.join(legacyDir, "imagemagick", "magick.exe"), "dummy-magick");
    await writeFile(path.join(legacyDir, "ffmpeg", "ffmpeg.exe"), "dummy-ffmpeg");
    await writeFile(path.join(legacyDir, "manifests", "run1.json"), "{}");
    await writeFile(path.join(legacyDir, ".picmagic-manifest-root.json"), "{}");

    // The migration is now async (MIG-2) and identifies binaries by a
    // -version probe (MIG-1); this legacy behavior check bypasses the probe
    // to keep asserting the copy/idempotency mechanics with dummy files.
    const summary = await migrateLegacyData(targetDir, [legacyDir], { integrityCheck: false });
    assert.equal(summary.migratedMagick, true);
    assert.equal(summary.migratedFfmpeg, true);
    assert.equal(summary.migratedManifests, 2);

    assert.equal(await Bun.file(path.join(targetDir, "imagemagick", "magick.exe")).text(), "dummy-magick");
    assert.equal(await Bun.file(path.join(targetDir, "ffmpeg", "ffmpeg.exe")).text(), "dummy-ffmpeg");
    assert.equal(await Bun.file(path.join(targetDir, "manifests", "run1.json")).text(), "{}");
    assert.equal(await Bun.file(path.join(targetDir, ".picmagic-manifest-root.json")).text(), "{}");

    // Idempotent: second run does not re-copy over existing target files
    const secondSummary = await migrateLegacyData(targetDir, [legacyDir], { integrityCheck: false });
    assert.equal(secondSummary.migratedMagick, false);
    assert.equal(secondSummary.migratedFfmpeg, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await check("migrateLegacyData refuses toolchain binaries that fail the -version identity check (MIG-1)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "compakta-migration-"));
  try {
    const legacyDir = path.join(root, "legacy-picmagick-gui");
    const targetDir = path.join(root, "Compakta");
    await mkdir(path.join(legacyDir, "imagemagick"), { recursive: true });
    await mkdir(path.join(legacyDir, "ffmpeg"), { recursive: true });
    await mkdir(targetDir, { recursive: true });

    // Impostor payloads: a text file named magick.exe cannot answer
    // "ImageMagick" on -version, and ffmpeg.exe cannot answer "ffmpeg version".
    await writeFile(path.join(legacyDir, "imagemagick", "magick.exe"), "not a real magick");
    await writeFile(path.join(legacyDir, "ffmpeg", "ffmpeg.exe"), "not a real ffmpeg");
    // But valid JSON manifests are still migrated - they are data, not code.
    await writeFile(path.join(legacyDir, ".compakta-manifest-run.json"), "{\"ok\":true}");
    // An invalid JSON manifest is refused.
    await writeFile(path.join(legacyDir, ".compakta-manifest-bad.json"), "{definitely not json");

    const summary = await migrateLegacyData(targetDir, [legacyDir]); // default: integrityCheck on
    assert.equal(summary.migratedMagick, false);
    assert.equal(summary.migratedFfmpeg, false);
    assert.ok(summary.integrityNote, "integrityNote explains the skips");
    assert.ok(!await existsSafe(path.join(targetDir, "imagemagick", "magick.exe")), "impostor binary NOT copied");
    assert.ok(!await existsSafe(path.join(targetDir, "ffmpeg", "ffmpeg.exe")), "impostor ffmpeg NOT copied");
    assert.equal(summary.migratedManifests, 1, "only the valid JSON manifest migrates");
    assert.ok(
      await existsSafe(path.join(targetDir, ".compakta-manifest-run.json")),
      "valid manifest copied",
    );
    assert.ok(
      !await existsSafe(path.join(targetDir, ".compakta-manifest-bad.json")),
      "invalid JSON manifest refused",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function existsSafe(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

await check("runHealthCheck fails (not warns) when destination is an existing file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "compakta-health-"));
  try {
    const srcDir = path.join(root, "src");
    const destFile = path.join(root, "not-a-dir");
    await mkdir(srcDir, { recursive: true });
    await writeFile(destFile, "blocking-file");

    const report = await runHealthCheck(srcDir, destFile, 1024, "avif");
    const destCheck = report.checks.find((c) => c.id === "dest");
    assert.ok(destCheck);
    assert.equal(destCheck.status, "fail");
    assert.equal(report.canRun, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await check("assertDestinationSafe rejects relative paths and nested destinations", () => {
  const src = path.resolve(tmpdir(), "compakta-src-safe-test");
  assert.throws(() => assertDestinationSafe(src, "relative-out"), /absolute path/i);
  assert.throws(() => assertDestinationSafe(src, path.join(src, "nested")), /inside the source/i);
  assert.doesNotThrow(() => assertDestinationSafe(src, `${src}-out`));
});

await check("runHealthCheck fails when destination is inside source", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "compakta-health-safe-"));
  try {
    const srcDir = path.join(root, "src");
    const nestedDest = path.join(srcDir, "out");
    await mkdir(srcDir, { recursive: true });

    const report = await runHealthCheck(srcDir, nestedDest, 1024, "avif");
    const safeCheck = report.checks.find((c) => c.id === "dest-safe");
    assert.ok(safeCheck);
    assert.equal(safeCheck.status, "fail");
    assert.equal(report.canRun, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

console.log(failures ? `\n${failures} platform check(s) failed` : "\nplatform OK");
if (failures) process.exit(1);
