/**
 * HTTP API router for `/api/video/*`.
 *
 * Shares the read-only `scan` cache and `sourceRoot` from `src/server.ts`,
 * while keeping all video state, FFmpeg discovery, 3-mode destination
 * resolution, slice estimation, frame-compare, and video jobs isolated.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import { planBudget, type BudgetPlan } from "../budget.ts";
import { formatBytes } from "../convert.ts";
import { findDuplicates } from "../dedupe.ts";
import { liveJob, manifestsFor, undoManifest } from "../jobs.ts";
import type { Manifest } from "../manifest.ts";
import { assertDestinationSafe, ensureDir, freeSpace } from "../paths.ts";
import { applyPolicy, type Policy } from "../policy.ts";
import type { ScannedFile, ScanResult } from "../scan.ts";
import { estimateVideoFromSample } from "./estimate.ts";
import {
  findFfmpeg,
  getFfmpegInstallProgress,
  installLatestFfmpeg,
  type FfmpegInfo,
} from "./ffmpeg.ts";
import {
  buildVideoEncoderArgs,
  isVideoOutputFormat,
  VIDEO_FORMAT_SPECS,
  VIDEO_OUTPUT_FORMATS,
  VIDEO_PRESETS,
  videoQualityDisplay,
  type VideoContainer,
  type VideoOutputFormat,
} from "./formats.ts";
import { runVideoHealthCheck } from "./health.ts";
import {
  getVideoJob,
  liveVideoJob,
  newVideoJob,
  pausedVideoJob,
} from "./jobs.ts";
import {
  buildVideoDateReport,
  extractVideoFramePng,
  probeManyVideos,
  probeVideo,
  verifyVideoOutputs,
} from "./meta.ts";
import {
  applyVideoPolicy,
  DEFAULT_VIDEO_POLICY,
  normaliseVideoPolicy,
  resolveVideoDestination,
  type VideoPolicy,
  type VideoPreview,
} from "./policy.ts";
import { analyseVideoSync, pendingVideoOnly } from "./sync.ts";
import { cleanOrphans } from "../sync.ts";
import { loadPersistedSettings, savePersistedSettings } from "../settings.ts";

export type SharedServerBridge = {
  getSourceRoot: () => string;
  getPhotoDestination: () => string;
  getPhotoPolicy: () => Policy;
  getBudgetBytes: () => number;
  setBudgetBytes: (bytes: number) => void;
  getScan: () => ScanResult | null;
  getFileByRel: (rel: string) => ScannedFile | undefined;
  getPreviewCacheDir: () => string;
};

type VideoServerState = {
  customDestination: string;
  ffmpeg: FfmpegInfo | null;
  policy: VideoPolicy;
  ratios: Record<VideoOutputFormat, number>;
  lastPreview: VideoPreview | null;
};

function defaultVideoRatios(): Record<VideoOutputFormat, number> {
  return Object.fromEntries(
    VIDEO_OUTPUT_FORMATS.map((id) => [id, VIDEO_FORMAT_SPECS[id].defaultRatio]),
  ) as Record<VideoOutputFormat, number>;
}

const savedVideoSettings = loadPersistedSettings();

const vState: VideoServerState = {
  customDestination: savedVideoSettings.videoCustomDestination ?? "",
  ffmpeg: null,
  policy: normaliseVideoPolicy(savedVideoSettings.videoPolicy ?? DEFAULT_VIDEO_POLICY),
  ratios: defaultVideoRatios(),
  lastPreview: null,
};

export function isVideoJobActive(): boolean {
  return Boolean(liveVideoJob()) || getFfmpegInstallProgress().running;
}

/** Current video projection, using the user's saved video recipe and ratios. */
export function currentVideoPreview(scan: ScanResult): VideoPreview {
  return applyVideoPolicy(scan, vState.policy, vState.ratios[vState.policy.outputFormat]);
}

export function resetVideoScanState(): void {
  vState.lastPreview = null;
  vState.ratios = defaultVideoRatios();
}

function requireFfmpeg(): FfmpegInfo {
  if (!vState.ffmpeg) vState.ffmpeg = findFfmpeg();
  return vState.ffmpeg;
}

function tryFfmpeg(): FfmpegInfo | null {
  if (!vState.ffmpeg) {
    try {
      vState.ffmpeg = findFfmpeg();
    } catch {
      vState.ffmpeg = null;
    }
  }
  return vState.ffmpeg;
}

function effectiveDest(bridge: SharedServerBridge, policy = vState.policy): string {
  return resolveVideoDestination(
    bridge.getSourceRoot(),
    bridge.getPhotoDestination(),
    vState.customDestination,
    policy,
  );
}

function mergeVideoPolicyUpdate(
  current: VideoPolicy,
  incoming: Partial<VideoPolicy> | undefined,
): VideoPolicy {
  if (!incoming) return current;
  const merged = { ...current, ...incoming };
  const nextFormat = isVideoOutputFormat(merged.outputFormat)
    ? merged.outputFormat
    : current.outputFormat;
  const formatChanged = nextFormat !== current.outputFormat;
  const spec = VIDEO_FORMAT_SPECS[nextFormat];

  return normaliseVideoPolicy({
    ...merged,
    outputFormat: nextFormat,
    container: incoming.container ?? (formatChanged ? (spec.ext as VideoContainer) : current.container),
    quality: incoming.quality ?? (formatChanged ? spec.quality.default : current.quality),
    speed: incoming.speed ?? (formatChanged ? spec.speed.default : current.speed),
  });
}

function hashRel(rel: string): string {
  let h = 0;
  for (let i = 0; i < rel.length; i++) {
    h = (Math.imul(31, h) + rel.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

function jsonReplacer(_k: string, v: unknown) {
  if (typeof v === "number" && !Number.isInteger(v)) return Number(v.toFixed(4));
  return v;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, jsonReplacer), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

async function readBody<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw Object.assign(new Error("Malformed JSON body."), { status: 400 });
  }
}

export async function handleVideoApi(
  subroute: string,
  req: Request,
  url: URL,
  bridge: SharedServerBridge,
): Promise<Response> {
  // ---- status ----
  if (subroute === "status" && req.method === "GET") {
    const ff = tryFfmpeg();
    const resolvedDest = effectiveDest(bridge);
    const free = await freeSpace(resolvedDest);
    const scan = bridge.getScan();

    return json({
      sourceRoot: bridge.getSourceRoot(),
      photoDestination: bridge.getPhotoDestination(),
      customDestination:
        vState.customDestination ||
        `${bridge.getSourceRoot().replace(/[\\/]+$/, "")}-${VIDEO_FORMAT_SPECS[vState.policy.outputFormat].destinationSuffix}`,
      effectiveDestination: resolvedDest,
      budgetBytes: bridge.getBudgetBytes(),
      ratio: vState.ratios[vState.policy.outputFormat],
      ratios: vState.ratios,
      outputFormat: vState.policy.outputFormat,
      formats: VIDEO_OUTPUT_FORMATS.map((id) => VIDEO_FORMAT_SPECS[id]),
      presets: VIDEO_PRESETS,
      policy: vState.policy,
      scanned: Boolean(scan),
      videoCount: scan?.totals.videoCount ?? 0,
      videoBytes: scan?.totals.videoBytes ?? 0,
      freeBytes: free,
      freeLabel: typeof free === "number" ? formatBytes(free) : "",
      ffmpeg: ff,
      liveJobId: liveVideoJob()?.id ?? null,
      pausedJobId: pausedVideoJob()?.id ?? null,
    });
  }

  // ---- config ----
  if (subroute === "config" && req.method === "POST") {
    const body = await readBody<{
      customDestination?: string;
      destination?: string;
      budgetBytes?: number;
      policy?: Partial<VideoPolicy>;
    }>(req);

    const nextPolicy = mergeVideoPolicyUpdate(vState.policy, body.policy);
    const rawDest = (body.customDestination || body.destination)?.trim();
    const nextCustom = rawDest !== undefined && rawDest !== ""
      ? rawDest
      : vState.customDestination;

    if (rawDest && !body.policy?.destMode) {
      nextPolicy.destMode = "custom";
    }

    const candidateDest = resolveVideoDestination(
      bridge.getSourceRoot(),
      bridge.getPhotoDestination(),
      nextCustom,
      nextPolicy,
    );
    assertDestinationSafe(bridge.getSourceRoot(), candidateDest);

    vState.policy = nextPolicy;
    if (rawDest !== undefined && rawDest !== "") {
      vState.customDestination = nextCustom;
    }
    if (typeof body.budgetBytes === "number") {
      bridge.setBudgetBytes(body.budgetBytes);
    }

    savePersistedSettings({
      videoPolicy: vState.policy,
      videoCustomDestination: vState.customDestination,
      budgetBytes: bridge.getBudgetBytes(),
    });

    return json({
      ok: true,
      effectiveDestination: candidateDest,
      customDestination: vState.customDestination,
      policy: vState.policy,
    });
  }

  // ---- preview ----
  if (subroute === "preview" && req.method === "POST") {
    const scan = bridge.getScan();
    if (!scan) throw Object.assign(new Error("Scan the library first."), { status: 400 });

    const body = await readBody<{
      policy?: Partial<VideoPolicy>;
      customDestination?: string;
      destination?: string;
    }>(req);
    if (body.policy) {
      vState.policy = mergeVideoPolicyUpdate(vState.policy, body.policy);
    }
    const rawDest = (body.customDestination || body.destination)?.trim();
    if (rawDest && !body.policy?.destMode) {
      vState.customDestination = rawDest;
      vState.policy.destMode = "custom";
    }

    const ratio = vState.ratios[vState.policy.outputFormat];
    const preview = applyVideoPolicy(scan, vState.policy, ratio);
    vState.lastPreview = preview;

    // The same scan also contains photos. Show their projection so the budget
    // meter represents the combined footprint of a mixed camera roll.
    const photoPreview = applyPolicy(scan, bridge.getPhotoPolicy());
    const otherModeBytes = photoPreview.estOutputBytes;
    const otherModeCount = photoPreview.estOutputFiles;

    const budget: BudgetPlan = planBudget(preview as any, bridge.getBudgetBytes());
    const dest = effectiveDest(bridge);
    const health = await runVideoHealthCheck(
      bridge.getSourceRoot(),
      dest,
      preview.estOutputBytes,
      vState.policy.outputFormat,
    );

    return json({
      convert: preview.convert.length,
      copy: preview.copy.length,
      skip: preview.skip.length,
      sourceBytes: preview.sourceBytes,
      estOutputBytes: preview.estOutputBytes,
      estOutputFiles: preview.estOutputFiles,
      ratio: preview.compressionRatio,
      outputFormat: vState.policy.outputFormat,
      formatLabel: VIDEO_FORMAT_SPECS[vState.policy.outputFormat].label,
      effectiveDestination: dest,
      byFolder: preview.byFolder,
      budget,
      otherModeBytes,
      otherModeCount,
      health: {
        checks: health.checks,
        magick: null,
        canRun: health.canRun,
        freeBytes: health.freeBytes,
      },
    });
  }

  // ---- estimate (3-second slice sampler) ----
  if (subroute === "estimate" && req.method === "POST") {
    const scan = bridge.getScan();
    if (!scan) throw Object.assign(new Error("Scan the library first."), { status: 400 });

    const body = await readBody<{ sampleSize?: number; policy?: Partial<VideoPolicy> }>(req);
    if (body.policy) {
      vState.policy = mergeVideoPolicyUpdate(vState.policy, body.policy);
    }

    const ff = requireFfmpeg();
    const format = vState.policy.outputFormat;
    const preview = applyVideoPolicy(scan, vState.policy, vState.ratios[format]);
    const est = await estimateVideoFromSample({
      convert: preview.convert,
      copy: preview.copy,
      ffmpeg: ff,
      policy: vState.policy,
      sampleSize: Math.max(2, Math.min(body.sampleSize ?? 5, 12)),
      flatRatio: vState.ratios[format],
    });

    if (est.method === "sampled" && est.sampleSize > 0) {
      vState.ratios[format] = est.ratio;
    }
    return json(est);
  }

  // ---- sync ----
  if (subroute === "sync" && req.method === "POST") {
    const scan = bridge.getScan();
    if (!scan) throw Object.assign(new Error("Scan the library first."), { status: 400 });

    const body = await readBody<{
      policy?: Partial<VideoPolicy>;
      customDestination?: string;
      destination?: string;
    }>(req);
    if (body.policy) {
      vState.policy = mergeVideoPolicyUpdate(vState.policy, body.policy);
    }
    const rawDest = (body.customDestination || body.destination)?.trim();
    if (rawDest && !body.policy?.destMode) {
      vState.customDestination = rawDest;
      vState.policy.destMode = "custom";
    }

    const preview = applyVideoPolicy(
      scan,
      vState.policy,
      vState.ratios[vState.policy.outputFormat],
    );
    const decisions = [...preview.convert, ...preview.copy];
    const dest = effectiveDest(bridge);
    const report = await analyseVideoSync(
      decisions,
      bridge.getSourceRoot(),
      dest,
      vState.policy,
    );
    const pending = pendingVideoOnly(decisions, report);
    const ratio = vState.ratios[vState.policy.outputFormat];

    return json({
      total: report.total,
      newCount: report.newCount,
      changedCount: report.changedCount,
      upToDateCount: report.upToDateCount,
      pendingCount: report.pendingCount,
      pendingSourceBytes: report.pendingSourceBytes,
      orphanCount: report.orphanCount,
      orphanBytes: report.orphanBytes,
      orphans: report.orphans.slice(0, 25),
      estOutputBytes: Math.round(
        pending.filter((d) => d.verdict === "convert").reduce((a, d) => a + d.file.size, 0) *
          ratio +
          pending.filter((d) => d.verdict === "copy").reduce((a, d) => a + d.file.size, 0),
      ),
      outputFormat: vState.policy.outputFormat,
      durationMs: report.durationMs,
      changed: report.entries.filter((e) => e.state === "changed").slice(0, 50),
      sampleNew: report.entries.filter((e) => e.state === "new").slice(0, 25),
    });
  }

  // ---- opt-in orphan cleanup ----
  if (subroute === "sync/clean-orphans" && req.method === "POST") {
    const scan = bridge.getScan();
    if (!scan) throw Object.assign(new Error("Scan the library first."), { status: 400 });
    const preview = applyVideoPolicy(scan, vState.policy, vState.ratios[vState.policy.outputFormat]);
    const decisions = [...preview.convert, ...preview.copy];
    const dest = effectiveDest(bridge);
    const report = await analyseVideoSync(decisions, bridge.getSourceRoot(), dest, vState.policy);
    const result = await cleanOrphans(dest, report.orphans);
    return json(result);
  }

  // ---- duplicates ----
  if (subroute === "duplicates" && req.method === "POST") {
    const scan = bridge.getScan();
    if (!scan) throw Object.assign(new Error("Scan the library first."), { status: 400 });

    const body = await readBody<{ maxHash?: number }>(req);
    const videoFiles = scan.files.filter((f) => f.category === "video");
    const preview = applyVideoPolicy(
      scan,
      vState.policy,
      vState.ratios[vState.policy.outputFormat],
    );
    const inScopeRels = new Set(
      [...preview.convert, ...preview.copy].map((d) => d.file.rel),
    );
    const eligibleVideos = videoFiles.filter((f) => inScopeRels.has(f.rel));

    // Reuse findDuplicates by constructing a permissive dummy policy for the pre-filtered video list
    const dummyPolicy: Policy = {
      excludedFolders: [],
      includedFolders: [],
      excludedFiles: [],
      includedFiles: [],
      extEnabled: Object.fromEntries(eligibleVideos.map((f) => [f.ext, true])),
      minSizeBytes: 0,
      copyUndersized: true,
      includeRaw: true,
      outputFormat: "avif",
      qualities: [60],
      flattenGif: false,
      heicSpeed: 6,
    };
    const asImageCategory = eligibleVideos.map((f) => ({ ...f, category: "image" as const }));
    const res = await findDuplicates(asImageCategory, dummyPolicy, {
      maxHash: Math.min(body.maxHash ?? 2000, 10000),
      signal: req.signal,
    });

    return json({
      groups: res.groups.slice(0, 300),
      groupCount: res.groups.length,
      duplicateFiles: res.duplicateFiles,
      duplicateBytes: res.duplicateBytes,
      hashedFiles: res.hashedFiles,
      durationMs: res.durationMs,
    });
  }

  // ---- dates audit (via ffprobe) ----
  if (subroute === "dates" && req.method === "POST") {
    const scan = bridge.getScan();
    if (!scan) throw Object.assign(new Error("Scan the library first."), { status: 400 });

    const body = await readBody<{ limit?: number }>(req);
    const ff = requireFfmpeg();
    const preview = applyVideoPolicy(
      scan,
      vState.policy,
      vState.ratios[vState.policy.outputFormat],
    );
    const all = [...preview.convert, ...preview.copy];
    const limit = Math.max(1, Math.min(body.limit ?? 2000, 10000));
    const subset = all.slice(0, limit);

    const facts = await probeManyVideos(
      ff.ffprobePath,
      subset.map((d) => d.file),
      8,
      req.signal,
    );
    const report = buildVideoDateReport(facts);

    return json({
      ...report,
      scanned: facts.length,
      inScope: all.length,
      truncated: all.length > subset.length,
      omitted: all.length - subset.length,
      undated: report.undated.slice(0, 500),
    });
  }

  // ---- visual frame compare ----
  if (subroute === "compare" && req.method === "POST") {
    const scan = bridge.getScan();
    if (!scan) throw Object.assign(new Error("Scan the library first."), { status: 400 });

    const body = await readBody<{ rel: string; qualities?: number[]; format?: string; timestampSec?: number }>(req);
    const file = bridge.getFileByRel(body.rel);
    if (!file) throw Object.assign(new Error(`Not in scan: ${body.rel}`), { status: 404 });

    const format = isVideoOutputFormat(body.format)
      ? body.format
      : vState.policy.outputFormat;
    const spec = VIDEO_FORMAT_SPECS[format];
    const ff = requireFfmpeg();
    const support = ff.formats[format];
    if (!support?.writable) {
      throw Object.assign(
        new Error(`${spec.label} cannot be encoded on this system (${support?.detail ?? "missing"}).`),
        { status: 400 },
      );
    }

    const facts = await probeVideo(ff.ffprobePath, file.abs, file.mtime, file.size);
    const dur = facts.durationSec && facts.durationSec > 0 ? facts.durationSec : 6;
    const sliceDur = Math.min(1.5, dur);
    const sampleTs =
      typeof body.timestampSec === "number" && Number.isFinite(body.timestampSec)
        ? Math.max(0, Math.min(body.timestampSec, Math.max(0, dur - sliceDur)))
        : dur > 2
          ? Number((dur * 0.25).toFixed(2))
          : 0;

    const outDir = bridge.getPreviewCacheDir();
    await ensureDir(outDir);

    const fileHash = hashRel(`${file.rel}:${file.mtime}:ts${sampleTs.toFixed(2)}`);
    const origPngName = `vcmp-orig-${fileHash}.png`;
    const origPngPath = path.join(outDir, origPngName);
    const okOrig = await extractVideoFramePng(ff.ffmpegPath, file.abs, sampleTs, origPngPath);
    if (!okOrig || !existsSync(origPngPath)) {
      throw new Error("Could not extract sample frame from original video.");
    }

    const qualities = (body.qualities ?? spec.compareQualities).slice(0, 5);
    const variants: { quality: number; label: string; url: string; bytes: number }[] = [];
    const errors: string[] = [];

    const hwEncoderName =
      format === "av1_hw"
        ? ff.hwEncoders.av1
        : format === "hevc_hw"
          ? ff.hwEncoders.hevc
          : null;

    for (const q of qualities) {
      const ext = format === "vp9" ? "webm" : vState.policy.container;
      const sliceClipName = `vcmp-clip-${fileHash}-${format}-q${q}-s${vState.policy.speed}.${ext}`;
      const sliceClipPath = path.join(outDir, sliceClipName);
      const framePngName = `vcmp-frame-${fileHash}-${format}-q${q}-s${vState.policy.speed}.png`;
      const framePngPath = path.join(outDir, framePngName);

      const args = buildVideoEncoderArgs({
        src: file.abs,
        out: sliceClipPath,
        format,
        container: vState.policy.container,
        quality: q,
        speed: vState.policy.speed,
        maxResolution: vState.policy.maxResolution,
        maxFps: vState.policy.maxFps,
        audioMode: vState.policy.audioMode,
        sourceAudioCodec: facts.audioCodec,
        sourceFps: facts.fps,
        isHdr: facts.isHdr,
        colorTransfer: facts.colorTransfer,
        tenBit: vState.policy.tenBit,
        filmGrain: vState.policy.filmGrain,
        customParams: vState.policy.customParams,
        hwEncoderName,
        sliceStartSec: sampleTs,
        sliceDurationSec: sliceDur,
      });

      await new Promise<void>((resolve) => {
        const c = spawn(ff.ffmpegPath, args, { windowsHide: true, stdio: "ignore" });
        c.on("close", () => resolve());
        c.on("error", () => resolve());
      });

      let projectedFullBytes = 0;
      try {
        const sliceSt = await stat(sliceClipPath);
        if (sliceSt.size === 0) {
          errors.push(`q${q}: encoder produced empty slice`);
          continue;
        }
        projectedFullBytes = Math.round(sliceSt.size * (dur / sliceDur));
      } catch {
        errors.push(`q${q}: failed to encode sample slice`);
        continue;
      }

      const okFrame = await extractVideoFramePng(ff.ffmpegPath, sliceClipPath, 0, framePngPath);
      await rm(sliceClipPath, { force: true }).catch(() => {});
      if (!okFrame) {
        errors.push(`q${q}: could not extract preview frame`);
        continue;
      }

      variants.push({
        quality: q,
        label: videoQualityDisplay(format, q),
        url: `/preview-cache/${framePngName}`,
        bytes: projectedFullBytes,
      });
    }

    return json({
      rel: file.rel,
      format,
      formatLabel: spec.label,
      originalUrl: `/preview-cache/${origPngName}`,
      originalBytes: file.size,
      originalExt: file.ext,
      mtime: file.mtime,
      durationSec: dur,
      timestampSec: sampleTs,
      variants,
      errors,
    });
  }

  // ---- health & managed FFmpeg ----
  if (subroute === "health" && req.method === "GET") {
    const scan = bridge.getScan();
    const preview = scan
      ? applyVideoPolicy(scan, vState.policy, vState.ratios[vState.policy.outputFormat])
      : null;
    const dest = effectiveDest(bridge);
    const report = await runVideoHealthCheck(
      bridge.getSourceRoot(),
      dest,
      preview?.estOutputBytes ?? 0,
      vState.policy.outputFormat,
    );
    return json({
      checks: report.checks,
      magick: report.ffmpeg
        ? {
            path: report.ffmpeg.ffmpegPath,
            version: report.ffmpeg.version,
            formats: report.ffmpeg.formats,
            avifWritable: report.ffmpeg.formats.av1.writable,
            libheif: report.ffmpeg.hwEncoders.av1 || report.ffmpeg.hwEncoders.hevc,
          }
        : null,
      canRun: report.canRun,
      freeBytes: report.freeBytes,
    });
  }

  if (subroute === "ffmpeg/progress" && req.method === "GET") {
    return json(getFfmpegInstallProgress());
  }

  if (subroute === "ffmpeg/install" && req.method === "POST") {
    if (liveJob() || liveVideoJob()) {
      throw Object.assign(
        new Error("A conversion is currently running or paused. Finish or cancel it first."),
        { status: 409 },
      );
    }
    const result = await installLatestFfmpeg();
    vState.ffmpeg = findFfmpeg(true);
    return json({ ...result, ffmpeg: vState.ffmpeg });
  }

  // ---- run ----
  if (subroute === "run" && req.method === "POST") {
    if (liveJob()) {
      throw Object.assign(
        new Error("A photo conversion is active on the Photos tab. Wait for it to finish or pause/cancel it first."),
        { status: 409 },
      );
    }
    const existingVid = liveVideoJob();
    if (existingVid) {
      throw Object.assign(
        new Error(
          existingVid.state === "paused"
            ? "A video conversion is paused. Resume or cancel it before starting another."
            : "A video conversion is already running.",
        ),
        { status: 409 },
      );
    }

    const scan = bridge.getScan();
    if (!scan) throw Object.assign(new Error("Scan the library first."), { status: 400 });

    const body = await readBody<{
      jobs?: number;
      cpuLimit?: number;
      overwrite?: boolean;
      onlyNew?: boolean;
      policy?: Partial<VideoPolicy>;
      customDestination?: string;
      destination?: string;
    }>(req);

    if (body.policy) {
      vState.policy = mergeVideoPolicyUpdate(vState.policy, body.policy);
    }
    const rawDest = (body.customDestination || body.destination)?.trim();
    if (rawDest && !body.policy?.destMode) {
      vState.customDestination = rawDest;
      vState.policy.destMode = "custom";
    }

    const ff = requireFfmpeg();
    const support = ff.formats[vState.policy.outputFormat];
    if (!support?.writable) {
      throw Object.assign(
        new Error(
          `${VIDEO_FORMAT_SPECS[vState.policy.outputFormat].label} is not writable on this machine.`,
        ),
        { status: 400 },
      );
    }

    const dest = effectiveDest(bridge);
    assertDestinationSafe(bridge.getSourceRoot(), dest);
    await mkdir(dest, { recursive: true });

    const preview = applyVideoPolicy(
      scan,
      vState.policy,
      vState.ratios[vState.policy.outputFormat],
    );
    let decisions = [...preview.convert, ...preview.copy];

    if (body.onlyNew) {
      const report = await analyseVideoSync(
        decisions,
        bridge.getSourceRoot(),
        dest,
        vState.policy,
      );
      decisions = pendingVideoOnly(decisions, report);
    }

    if (decisions.length === 0) {
      throw Object.assign(
        new Error("Nothing to do — all selected videos are already converted."),
        { status: 400 },
      );
    }

    const jobs = Math.max(1, Math.min(body.jobs ?? 1, 8));
    const cpuLimit = Math.max(10, Math.min(Number(body.cpuLimit) || 70, 100));
    const job = newVideoJob();

    void job.start({
      decisions,
      sourceRoot: bridge.getSourceRoot(),
      effectiveDestination: dest,
      ffmpeg: ff,
      policy: vState.policy,
      jobs,
      cpuLimit,
      overwrite: Boolean(body.overwrite),
    });

    return json({
      jobId: job.id,
      total: decisions.length,
      jobs,
      cpuLimit,
      outputFormat: vState.policy.outputFormat,
    });
  }

  // ---- SSE stream & job controls ----
  if (subroute.startsWith("stream/") && req.method === "GET") {
    const job = getVideoJob(subroute.slice("stream/".length));
    if (!job) throw Object.assign(new Error("Unknown video job."), { status: 404 });

    const encoder = new TextEncoder();
    let ping: ReturnType<typeof setInterval> | null = null;
    let detach: (() => void) | null = null;

    const stream = new ReadableStream({
      start(controller) {
        const send = (p: unknown) => {
          try {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(p, jsonReplacer)}\n\n`),
            );
          } catch {
            /* client disconnected */
          }
        };
        send({ type: "hello", jobId: job.id, state: job.state });
        job.on("progress", send);
        ping = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": ping\n\n"));
          } catch {
            /* ignore */
          }
        }, 15_000);
        detach = () => {
          job.off("progress", send);
        };
      },
      cancel() {
        detach?.();
        if (ping) clearInterval(ping);
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  }

  if (subroute.startsWith("jobs/") && req.method === "POST") {
    const job = getVideoJob(subroute.slice("jobs/".length));
    if (!job) throw Object.assign(new Error("Unknown video job."), { status: 404 });
    const body = await readBody<{ jobs?: number; cpuLimit?: number }>(req);
    const res: { ok: boolean; jobs?: number; cpuLimit?: number } = { ok: true };
    if (body.jobs !== undefined) res.jobs = job.setJobs(Number(body.jobs));
    if (body.cpuLimit !== undefined) res.cpuLimit = job.setCpuLimit(Number(body.cpuLimit));
    return json(res);
  }

  if (subroute.startsWith("pause/") && req.method === "POST") {
    const job = getVideoJob(subroute.slice("pause/".length));
    if (!job) throw Object.assign(new Error("Unknown video job."), { status: 404 });
    const ok = job.pause();
    return json({
      ok,
      state: job.state,
      message: ok ? "Pausing after current video…" : `Cannot pause from "${job.state}".`,
    });
  }

  if (subroute.startsWith("resume/") && req.method === "POST") {
    const job = getVideoJob(subroute.slice("resume/".length));
    if (!job) throw Object.assign(new Error("Unknown video job."), { status: 404 });
    void job.resume();
    return json({ ok: true, state: job.state, total: job.progress().total });
  }

  if (subroute === "job/state" && req.method === "GET") {
    const job = getVideoJob(url.searchParams.get("id") ?? "");
    if (!job) throw Object.assign(new Error("Unknown video job."), { status: 404 });
    return json({ id: job.id, ...job.progress() });
  }

  if (subroute.startsWith("cancel/") && req.method === "POST") {
    const job = getVideoJob(subroute.slice("cancel/".length));
    if (!job) throw Object.assign(new Error("Unknown video job."), { status: 404 });
    job.cancel();
    return json({ ok: true, state: job.state });
  }

  // ---- verify ----
  if (subroute === "verify" && req.method === "POST") {
    const body = await readBody<{ jobId?: string; limit?: number }>(req);
    const job = body.jobId ? getVideoJob(body.jobId) : undefined;
    if (!job) throw Object.assign(new Error("Pass jobId of a finished video run."), { status: 400 });
    if (job.state === "running" || job.state === "paused") {
      throw Object.assign(new Error(`That job is ${job.state}. Let it finish first.`), { status: 409 });
    }
    if (!job.results.length) {
      throw Object.assign(new Error("That run produced no video files to verify."), { status: 400 });
    }

    const ff = requireFfmpeg();
    const report = await verifyVideoOutputs(job.results, ff.ffprobePath, {
      jobs: 6,
      limit: Math.max(1, Math.min(body.limit ?? 100, 2000)),
    });
    return json({
      checked: report.checked,
      passed: report.passed,
      failed: report.failed,
      dateSurvived: report.dateSurvived,
      durationMs: report.durationMs,
      rows: report.rows.filter((r) => !r.ok).slice(0, 200),
    });
  }

  // ---- manifests & undo ----
  if (subroute === "manifests" && req.method === "GET") {
    const dest = effectiveDest(bridge);
    const list: Manifest[] = await manifestsFor(dest);
    return json({
      manifests: list.map((m: Manifest) => ({
        id: m.id,
        createdAt: m.createdAt,
        summary: m.summary,
        quality: m.quality,
        outputFormat: m.outputFormat ?? "av1",
        destination: m.destination,
      })),
    });
  }

  if (subroute === "undo" && req.method === "POST") {
    const body = await readBody<{ id: string; dryRun?: boolean }>(req);
    const dest = effectiveDest(bridge);
    const list: Manifest[] = await manifestsFor(dest);
    const manifest = list.find((m: Manifest) => m.id === body.id);
    if (!manifest) throw Object.assign(new Error("No such manifest."), { status: 404 });
    const result = await undoManifest(manifest, { dryRun: body.dryRun });
    return json(result);
  }

  throw Object.assign(new Error(`Unknown video route: /api/video/${subroute}`), { status: 404 });
}
