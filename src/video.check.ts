/**
 * Video subsystem regression and safety checks.
 *
 * Verifies Option-A quality -> CRF mapping, the 3 destination structure modes
 * (merge, /video subfolder, custom), tinkerer FFmpeg arguments, and photo-safe
 * Sync and Undo when merging into a Photo destination directory.
 *
 *   bun run src/video.check.ts
 */
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { existsSync } from "node:fs";
import { undoManifest, writeManifest } from "./manifest.ts";
import { REL_SEP } from "./platform.ts";
import type { ScannedFile, ScanResult } from "./scan.ts";
import { isTrustedFfmpegUrl } from "./video/ffmpeg.ts";
import {
  buildVideoEncoderArgs,
  crfToVideoQuality,
  DEFAULT_VIDEO_FORMAT,
  sanitizeCustomParams,
  VIDEO_FORMAT_SPECS,
  VIDEO_OUTPUT_FORMATS,
  VIDEO_PRESETS,
  videoQualityDisplay,
  videoQualityToCrf,
  x265PresetName,
} from "./video/formats.ts";
import {
  applyVideoPolicy,
  DEFAULT_VIDEO_POLICY,
  normaliseVideoPolicy,
  resolveVideoDestination,
  videoOutputPathFor,
  type VideoDecision,
  type VideoPolicy,
} from "./video/policy.ts";
import { analyseVideoSync } from "./video/sync.ts";

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

function scannedVideo(
  parts: string[],
  size = 50 * 1024 * 1024,
  ext = "mp4",
): ScannedFile {
  const rel = nativeRel(...parts);
  return {
    abs: path.resolve("/library", rel),
    rel,
    dir: path.dirname(rel),
    name: parts[parts.length - 1],
    ext,
    size,
    category: "video",
    mtime: 1_700_000_000_000,
  };
}

function scannedPhoto(parts: string[], size = 4 * 1024 * 1024): ScannedFile {
  const rel = nativeRel(...parts);
  return {
    abs: path.resolve("/library", rel),
    rel,
    dir: path.dirname(rel),
    name: parts[parts.length - 1],
    ext: "jpg",
    size,
    category: "image",
    mtime: 1_700_000_000_000,
  };
}

function withVideoPolicy(patch: Partial<VideoPolicy>): VideoPolicy {
  return normaliseVideoPolicy({ ...DEFAULT_VIDEO_POLICY, ...patch });
}

console.log(`video check: ${process.platform}, separator: ${JSON.stringify(REL_SEP)}`);

// ── 1. Registry & Optimal Zero-Touch Defaults ──────────────────────────────
await check("video format registry order and default", () => {
  assert.deepEqual(
    [...VIDEO_OUTPUT_FORMATS],
    ["av1", "hevc", "av1_hw", "hevc_hw", "vp9"],
  );
  assert.equal(DEFAULT_VIDEO_FORMAT, "av1");
});

await check("zero-touch defaults match the knee-of-the-curve specification", () => {
  const p = normaliseVideoPolicy(undefined);
  assert.equal(p.destMode, "merge");
  assert.equal(p.outputFormat, "av1");
  assert.equal(p.container, "mp4");
  assert.equal(p.quality, 60); // CRF 28
  assert.equal(p.speed, 6);    // SVT-AV1 preset 6
  assert.equal(p.maxResolution, 0);
  assert.equal(p.maxFps, 0);
  assert.equal(p.audioMode, "auto");
  assert.equal(p.tenBit, true);
  assert.equal(p.filmGrain, 0);
  assert.equal(p.skipAlreadyEfficient, true);
  assert.equal(p.customParams, "");
});

await check("1-click tinkerer presets cover archival, balanced, and spacesaver", () => {
  assert.equal(VIDEO_PRESETS.archival.quality, 72); // CRF 22
  assert.equal(VIDEO_PRESETS.balanced.quality, 60); // CRF 28
  assert.equal(VIDEO_PRESETS.spacesaver.quality, 44); // CRF 36
  assert.equal(VIDEO_PRESETS.spacesaver.maxResolution, 1080);
  assert.equal(VIDEO_PRESETS.spacesaver.maxFps, 30);
});

// ── 2. Option A Quality <-> CRF Mapping ────────────────────────────────────
await check("Option A quality slider maps Left (smaller/lossy) -> Right (better/archival)", () => {
  // AV1 / VP9
  assert.equal(videoQualityToCrf("av1", 20), 48); // Leftmost: max lossy
  assert.equal(videoQualityToCrf("av1", 44), 36); // Space saver
  assert.equal(videoQualityToCrf("av1", 60), 28); // Default sweet spot
  assert.equal(videoQualityToCrf("av1", 72), 22); // Archival
  assert.equal(videoQualityToCrf("av1", 84), 16); // Rightmost: near-lossless

  // HEVC (offset by -4)
  assert.equal(videoQualityToCrf("hevc", 20), 44);
  assert.equal(videoQualityToCrf("hevc", 60), 24);
  assert.equal(videoQualityToCrf("hevc", 72), 18);
  assert.equal(videoQualityToCrf("hevc", 84), 12);

  // Round-trip
  for (const q of [20, 36, 44, 60, 72, 84]) {
    assert.equal(crfToVideoQuality("av1", videoQualityToCrf("av1", q)), q);
    assert.equal(crfToVideoQuality("hevc", videoQualityToCrf("hevc", q)), q);
  }

  assert.equal(videoQualityDisplay("av1", 60), "q60 (CRF 28)");
  assert.equal(videoQualityDisplay("hevc", 60), "q60 (CRF 24)");
});

// ── 3. The Three Video Destination Modes (merge, subfolder, custom) ────────
await check("Mode 1 (merge): places videos in the exact same shadow folders as photos", () => {
  const srcRoot = path.resolve("/dcim");
  const photoDest = path.resolve("/dcim-avif");
  const policy = withVideoPolicy({ destMode: "merge", outputFormat: "av1", container: "mp4" });

  const resolved = resolveVideoDestination(srcRoot, photoDest, "", policy);
  assert.equal(resolved, photoDest);

  const decision: VideoDecision = {
    file: scannedVideo(["2026-Vacation", "Beach", "VID_001.mov"]),
    verdict: "convert",
    reason: "ok",
  };
  assert.equal(
    videoOutputPathFor(decision, srcRoot, resolved, policy),
    path.join(photoDest, nativeRel("2026-Vacation", "Beach"), "VID_001.mp4"),
  );
});

await check("Mode 2 (subfolder): mirrors the folder structure inside <photoDest>/video/", () => {
  const srcRoot = path.resolve("/dcim");
  const photoDest = path.resolve("/dcim-avif");
  const policy = withVideoPolicy({ destMode: "subfolder", outputFormat: "av1", container: "mp4" });

  const resolved = resolveVideoDestination(srcRoot, photoDest, "", policy);
  assert.equal(resolved, path.join(photoDest, "video"));

  const decision: VideoDecision = {
    file: scannedVideo(["2026-Vacation", "Beach", "VID_001.mov"]),
    verdict: "convert",
    reason: "ok",
  };
  assert.equal(
    videoOutputPathFor(decision, srcRoot, resolved, policy),
    path.join(photoDest, "video", nativeRel("2026-Vacation", "Beach"), "VID_001.mp4"),
  );
});

await check("Mode 3 (custom): mirrors the folder structure in a separate location away from photos", () => {
  const srcRoot = path.resolve("/dcim");
  const photoDest = path.resolve("/dcim-avif");
  const customDest = path.resolve("/external-drive/videos-archive");
  const policy = withVideoPolicy({ destMode: "custom", outputFormat: "av1", container: "mkv" });

  const resolved = resolveVideoDestination(srcRoot, photoDest, customDest, policy);
  assert.equal(resolved, customDest);

  const decision: VideoDecision = {
    file: scannedVideo(["2026-Vacation", "VID_001.mov"]),
    verdict: "convert",
    reason: "ok",
  };
  assert.equal(
    videoOutputPathFor(decision, srcRoot, resolved, policy),
    path.join(customDest, nativeRel("2026-Vacation"), "VID_001.mkv"),
  );

  // When custom path is empty, falls back to <sourceRoot>-<formatSuffix>
  const defaultCustom = resolveVideoDestination(srcRoot, photoDest, "", policy);
  assert.equal(defaultCustom, `${srcRoot}-av1`);
});

await check("same-stem videos get distinct output paths", () => {
  const srcRoot = path.resolve("/dcim");
  const dest = path.resolve("/dcim-avif");
  const policy = withVideoPolicy({ minSizeBytes: 0, destMode: "merge", container: "mp4" });
  const preview = applyVideoPolicy(
    {
      files: [
        scannedVideo(["reel", "CLIP.MOV"], 50 * 1024 * 1024, "mov"),
        scannedVideo(["reel", "CLIP.MP4"], 50 * 1024 * 1024, "mp4"),
      ],
    } as ScanResult,
    policy,
  );
  const outs = preview.convert
    .map((d) => path.basename(videoOutputPathFor(d, srcRoot, dest, policy)))
    .sort();
  assert.deepEqual(outs, ["CLIP-mov.mp4", "CLIP-mp4.mp4"]);
});

await check("copied videos keep their original filename and extension in all modes", () => {
  const srcRoot = path.resolve("/dcim");
  const photoDest = path.resolve("/dcim-avif");
  const policy = withVideoPolicy({ destMode: "merge", outputFormat: "av1", container: "mp4" });
  const decision: VideoDecision = {
    file: scannedVideo(["2026-Vacation", "clip.mov"], 512 * 1024, "mov"),
    verdict: "copy",
    reason: "undersized",
  };

  assert.equal(
    videoOutputPathFor(decision, srcRoot, photoDest, policy),
    path.join(photoDest, nativeRel("2026-Vacation"), "clip.mov"),
  );
});

// ── 4. FFmpeg CLI Builder & Tinkerer Options ───────────────────────────────
await check("default zero-touch AV1 encoder arguments", () => {
  const args = buildVideoEncoderArgs({
    src: "C:\\dcim\\VID_01.mov",
    out: "C:\\dcim-avif\\VID_01.mp4",
    format: "av1",
    container: "mp4",
    quality: 60,
    speed: 6,
  });

  assert.deepEqual(args, [
    "-hide_banner", "-nostdin", "-y",
    "-i", "C:\\dcim\\VID_01.mov",
    "-map", "0:v:0",
    "-map", "0:a:0?",
    "-map_metadata", "0",
    "-metadata:s:v:0", "rotate=0",
    "-c:v", "libsvtav1",
    "-crf", "28",
    "-preset", "6",
    "-pix_fmt", "yuv420p10le",
    "-svtav1-params", "tune=0:enable-overlays=1:scd=1",
    "-c:a", "copy",
    "-movflags", "+use_metadata_tags+faststart",
    "C:\\dcim-avif\\VID_01.mp4",
  ]);
});

await check("tinkerer overrides: 1080p cap, 30fps cap, film grain, Opus audio, MKV, custom params", () => {
  const args = buildVideoEncoderArgs({
    src: "in.mp4",
    out: "out.mkv",
    format: "av1",
    container: "mkv",
    quality: 44, // CRF 36
    speed: 7,
    maxResolution: 1080,
    maxFps: 30,
    sourceFps: 60,
    audioMode: "opus64",
    tenBit: true,
    filmGrain: 12,
    customParams: "enable-qm=1:qm-min=0",
    progressPipe: true,
  });

  assert.equal(args.includes("-vf"), true);
  const vfArg = args[args.indexOf("-vf") + 1];
  // maxResolution is a short-edge cap: landscape caps height, portrait caps width.
  assert.equal(vfArg.includes("if(gt(iw,ih),-2,min(1080,iw))"), true);
  assert.equal(vfArg.includes("if(gt(iw,ih),min(1080,ih),-2)"), true);
  assert.equal(vfArg.includes("fps=30"), true);

  assert.equal(args[args.indexOf("-crf") + 1], "36");
  assert.equal(args[args.indexOf("-preset") + 1], "7");
  assert.equal(
    args[args.indexOf("-svtav1-params") + 1],
    "tune=0:enable-overlays=1:scd=1:film-grain=12:film-grain-denoise=1:enable-qm=1:qm-min=0",
  );
  assert.equal(args.includes("libopus"), true);
  assert.equal(args.includes("64k"), true);
  // MKV does not use MP4-only -movflags
  assert.equal(args.includes("-movflags"), false);
  assert.equal(args.includes("-progress"), true);
});

await check("smart audio mode transcodes uncompressed camera PCM but copies AAC", () => {
  const pcmArgs = buildVideoEncoderArgs({
    src: "camera.mov",
    out: "camera.mp4",
    format: "av1",
    container: "mp4",
    quality: 60,
    speed: 6,
    audioMode: "auto",
    sourceAudioCodec: "pcm_s16le",
  });
  assert.equal(pcmArgs[pcmArgs.indexOf("-c:a") + 1], "aac");

  const aacArgs = buildVideoEncoderArgs({
    src: "phone.mp4",
    out: "phone.mp4",
    format: "av1",
    container: "mp4",
    quality: 60,
    speed: 6,
    audioMode: "auto",
    sourceAudioCodec: "aac",
  });
  assert.equal(aacArgs[aacArgs.indexOf("-c:a") + 1], "copy");
});

await check("HEVC and GPU hardware encoder arguments", () => {
  const hevcArgs = buildVideoEncoderArgs({
    src: "in.mp4",
    out: "out.mp4",
    format: "hevc",
    container: "mp4",
    quality: 60, // CRF 24
    speed: 5,    // medium
  });
  assert.equal(hevcArgs[hevcArgs.indexOf("-c:v") + 1], "libx265");
  assert.equal(hevcArgs[hevcArgs.indexOf("-crf") + 1], "24");
  assert.equal(hevcArgs[hevcArgs.indexOf("-preset") + 1], "medium");
  assert.equal(hevcArgs[hevcArgs.indexOf("-tag:v") + 1], "hvc1");
  assert.equal(x265PresetName(4), "slow");
  assert.equal(x265PresetName(6), "fast");

  const nvencArgs = buildVideoEncoderArgs({
    src: "in.mp4",
    out: "out.mp4",
    format: "av1_hw",
    container: "mp4",
    quality: 60,
    speed: 6,
    hwEncoderName: "av1_nvenc",
  });
  assert.equal(nvencArgs[nvencArgs.indexOf("-c:v") + 1], "av1_nvenc");
  assert.equal(nvencArgs[nvencArgs.indexOf("-preset") + 1], "p4");
  assert.equal(nvencArgs[nvencArgs.indexOf("-cq") + 1], "28");
});

await check("rejects unsafe custom encoder parameters and untrusted FFmpeg URLs", () => {
  assert.equal(sanitizeCustomParams("enable-qm=1:qm-min=0"), "enable-qm=1:qm-min=0");
  assert.throws(() => sanitizeCustomParams("tune=0; rm -rf /"));
  assert.throws(() => sanitizeCustomParams("tune=0 -vf scale=0:0"));

  assert.equal(
    isTrustedFfmpegUrl("https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"),
    true,
  );
  assert.equal(
    isTrustedFfmpegUrl("https://evil.example.com/BtbN/FFmpeg-Builds/releases/download/x.zip"),
    false,
  );
});

// ── 5. Policy Isolation & Photo-Safe Merge Sync / Undo ─────────────────────
await check("applyVideoPolicy ignores photos in the scan and only plans videos", () => {
  const scan = {
    files: [
      scannedPhoto(["album", "IMG_01.jpg"]),
      scannedPhoto(["album", "IMG_02.jpg"]),
      scannedVideo(["album", "VID_01.mp4"]),
    ],
  } as unknown as ScanResult;

  const preview = applyVideoPolicy(scan, DEFAULT_VIDEO_POLICY);
  assert.equal(preview.convert.length, 1);
  assert.equal(preview.convert[0].file.name, "VID_01.mp4");
  assert.equal(preview.skip.length, 0);
});

await check("Sync and Undo in 'merge' mode never flag or delete compressed photos", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "picmagick-video-merge-"));
  try {
    const source = path.join(root, "dcim");
    const sharedDest = path.join(root, "dcim-avif");
    await mkdir(path.join(source, "2026"), { recursive: true });
    await mkdir(path.join(sharedDest, "2026"), { recursive: true });

    // 1. Existing compressed photos sitting in the shared destination
    const photoAvif = path.join(sharedDest, "2026", "IMG_001.avif");
    const photoJxl = path.join(sharedDest, "2026", "IMG_002.jxl");
    await writeFile(photoAvif, "compressed-avif-photo");
    await writeFile(photoJxl, "compressed-jxl-photo");

    // 2. Source video and its converted output in the same folder
    const srcVid = path.join(source, "2026", "VID_001.mov");
    const outVid = path.join(sharedDest, "2026", "VID_001.mp4");
    const orphanVid = path.join(sharedDest, "2026", "OLD_ORPHAN.mp4");
    await writeFile(srcVid, "source-video-bytes");
    const srcSt = await stat(srcVid);
    await writeFile(outVid, "encoded-av1-video");
    await writeFile(orphanVid, "orphan-video");

    const newer = new Date(srcSt.mtimeMs + 10_000);
    await utimes(outVid, newer, newer);

    const decision: VideoDecision = {
      file: {
        abs: srcVid,
        rel: nativeRel("2026", "VID_001.mov"),
        dir: "2026",
        name: "VID_001.mov",
        ext: "mov",
        size: srcSt.size,
        category: "video",
        mtime: srcSt.mtimeMs,
      },
      verdict: "convert",
      reason: "ok",
    };

    const policy = withVideoPolicy({ destMode: "merge", outputFormat: "av1", container: "mp4" });
    const syncReport = await analyseVideoSync([decision], source, sharedDest, policy);

    // VID_001 is up to date
    assert.equal(syncReport.upToDateCount, 1);
    // IMG_001.avif and IMG_002.jxl are NOT reported as orphans; only OLD_ORPHAN.mp4 is!
    assert.equal(syncReport.orphans.length, 1);
    assert.equal(path.basename(syncReport.orphans[0].out), "OLD_ORPHAN.mp4");

    // 3. Write a video manifest in sharedDest and Undo it
    const manifest = await writeManifest(
      sharedDest,
      "video-run-test",
      {
        createdAt: Date.now(),
        sourceRoot: source,
        destination: sharedDest,
        quality: [60],
        heicSpeed: 6,
        outputFormat: "av1" as any,
        tool: "picmagick-gui-video",
      },
      [
        {
          rel: decision.file.rel,
          src: srcVid,
          out: outVid,
          status: "converted",
          seconds: 2.5,
          inBytes: srcSt.size,
          outBytes: 17,
        },
      ],
    );

    const undoRes = await undoManifest(manifest);
    assert.equal(undoRes.removed, 1);
    assert.equal(existsSync(outVid), false);
    // Photos in the same folder remain 100% untouched!
    assert.equal(existsSync(photoAvif), true);
    assert.equal(existsSync(photoJxl), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

console.log(failures ? `\n${failures} video check(s) failed` : "\nvideo OK");
if (failures) process.exit(1);
