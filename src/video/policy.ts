/**
 * Video policy normalization, destination mode resolution (merge, subfolder, custom),
 * and worklist classification.
 */
import path from "node:path";

import { VIDEO_EXTS, extOf } from "../paths.ts";
import { CASE_INSENSITIVE, relTop } from "../platform.ts";
import type { ScannedFile, ScanResult } from "../scan.ts";
import {
  DEFAULT_VIDEO_FORMAT,
  isVideoOutputFormat,
  VIDEO_FORMAT_SPECS,
  type AudioMode,
  type MaxFps,
  type MaxResolution,
  type VideoContainer,
  type VideoOutputFormat,
} from "./formats.ts";

export type VideoDestMode = "merge" | "subfolder" | "custom";

export type VideoPolicy = {
  // Folder & File Selection
  excludedFolders: string[];
  includedFolders: string[];
  excludedFiles: string[];
  includedFiles: string[];
  extEnabled: Record<string, boolean>;
  minSizeBytes: number;
  copyUndersized: boolean;

  // Destination Mode
  destMode: VideoDestMode;

  // Core Codec & Quality
  outputFormat: VideoOutputFormat;
  container: VideoContainer;
  quality: number;
  speed: number;

  // Tinkerer Knobs
  maxResolution: MaxResolution;
  maxFps: MaxFps;
  audioMode: AudioMode;
  tenBit: boolean;
  filmGrain: number;
  skipAlreadyEfficient: boolean;
  customParams: string;
};

export const DEFAULT_VIDEO_POLICY: VideoPolicy = {
  excludedFolders: [],
  includedFolders: [],
  excludedFiles: [],
  includedFiles: [],
  extEnabled: Object.fromEntries(VIDEO_EXTS.map((e) => [e, true])),
  minSizeBytes: 1024 * 1024, // 1 MB
  copyUndersized: true,

  destMode: "merge",
  outputFormat: DEFAULT_VIDEO_FORMAT,
  container: "mp4",
  quality: 60, // CRF 28
  speed: 6,    // Preset 6

  maxResolution: 0,
  maxFps: 0,
  audioMode: "auto",
  tenBit: true,
  filmGrain: 0,
  skipAlreadyEfficient: true,
  customParams: "",
};

export type VideoVerdict = "convert" | "copy" | "skip";

export type VideoDecision = {
  file: ScannedFile;
  verdict: VideoVerdict;
  reason: string;
  /**
   * Appended to the output stem when a sibling in the same folder would
   * otherwise land on the identical output path (`CLIP.MOV` + `CLIP.MP4`
   * -> `CLIP-mov.mp4` + `CLIP-mp4.mp4`).
   */
  outStemSuffix?: string;
};

export type VideoPreview = {
  convert: VideoDecision[];
  copy: VideoDecision[];
  skip: VideoDecision[];
  sourceBytes: number;
  estOutputBytes: number;
  estOutputFiles: number;
  compressionRatio: number;
  byFolder: {
    rel: string;
    convertCount: number;
    copyCount: number;
    convertBytes: number;
    copyBytes: number;
    estOutputBytes: number;
  }[];
};

export function normaliseVideoPolicy(p?: Partial<VideoPolicy>): VideoPolicy {
  const base = { ...DEFAULT_VIDEO_POLICY, ...(p ?? {}) };
  const extEnabled: Record<string, boolean> = {};
  for (const ext of VIDEO_EXTS) {
    extEnabled[ext] = base.extEnabled?.[ext] ?? true;
  }

  const cleanFolders = (v: string[] | undefined) => [
    ...new Set(
      (v ?? [])
        .filter((s) => typeof s === "string" && s.length > 0)
        .map((s) => s.replace(/[\\/]+$/, "")),
    ),
  ];
  const cleanFiles = (v: string[] | undefined) => [
    ...new Set((v ?? []).filter((s) => typeof s === "string" && s.length > 0)),
  ];

  const outputFormat = isVideoOutputFormat(base.outputFormat)
    ? base.outputFormat
    : DEFAULT_VIDEO_FORMAT;
  const spec = VIDEO_FORMAT_SPECS[outputFormat];
  const rawContainer = ["mp4", "mkv", "webm"].includes(base.container) ? base.container : "mp4";
  const container: VideoContainer =
    outputFormat === "vp9"
      ? "webm"
      : (rawContainer === "webm" && (outputFormat === "hevc" || outputFormat === "hevc_hw"))
        ? "mp4"
        : rawContainer;

  return {
    ...base,
    excludedFolders: cleanFolders(base.excludedFolders),
    includedFolders: cleanFolders(base.includedFolders),
    excludedFiles: cleanFiles(base.excludedFiles),
    includedFiles: cleanFiles(base.includedFiles),
    extEnabled,
    minSizeBytes: Math.max(0, Math.round(Number(base.minSizeBytes) || 0)),
    copyUndersized: Boolean(base.copyUndersized),
    destMode: base.destMode === "subfolder" || base.destMode === "custom" ? base.destMode : "merge",
    outputFormat,
    container,
    quality: Math.max(20, Math.min(84, Math.round(Number(base.quality) || 60))),
    speed: Math.max(spec.speed.min, Math.min(spec.speed.max, Math.round(Number(base.speed) || spec.speed.default))),
    maxResolution: [0, 2160, 1440, 1080, 720].includes(base.maxResolution as any)
      ? base.maxResolution
      : 0,
    maxFps: [0, 60, 30].includes(base.maxFps as any) ? base.maxFps : 0,
    audioMode: ["auto", "copy", "opus128", "opus64", "mute"].includes(base.audioMode)
      ? base.audioMode
      : "auto",
    tenBit: base.tenBit !== false,
    filmGrain: Math.max(0, Math.min(24, Math.round(Number(base.filmGrain) || 0))),
    skipAlreadyEfficient: base.skipAlreadyEfficient !== false,
    customParams: typeof base.customParams === "string" ? base.customParams.trim() : "",
  };
}

function stripTrailingSeparatorsSafe(p: string): string {
  if (p === "/" || p === "\\" || /^[A-Za-z]:[\\/]$/.test(p)) return p;
  return p.replace(/[\\/]+$/, "");
}

export function defaultVideoDestination(
  sourceRoot: string,
  format: VideoOutputFormat,
): string {
  const suffix = VIDEO_FORMAT_SPECS[format].destinationSuffix;
  return `${stripTrailingSeparatorsSafe(sourceRoot)}-${suffix}`;
}

export function resolveVideoDestination(
  sourceRoot: string,
  photoDest: string,
  customDest: string,
  policy: VideoPolicy,
): string {
  const custom = customDest.trim();
  if (policy.destMode === "custom") {
    if (custom) return custom;
    return defaultVideoDestination(sourceRoot, policy.outputFormat);
  }
  if (policy.destMode === "subfolder") {
    return path.join(photoDest, "video");
  }
  return photoDest;
}

export function videoOutputPathFor(
  decision: VideoDecision,
  sourceRoot: string,
  effectiveDest: string,
  policy: VideoPolicy,
): string {
  if (decision.verdict === "copy") {
    return path.join(effectiveDest, decision.file.rel);
  }

  const outExt = policy.outputFormat === "vp9" ? "webm" : policy.container;
  const dir = decision.file.dir === "." ? "" : decision.file.dir;
  const ext = path.extname(decision.file.name);
  const base = ext ? decision.file.name.slice(0, -ext.length) : decision.file.name;
  return path.join(effectiveDest, dir, `${base}${decision.outStemSuffix ?? ""}.${outExt}`);
}

const SLASH_LIKE = /[\u002F\u005C\u2044\u2215\u29F5\u29F8\uFF0F\uFF3C]/g;

function foldKey(s: string): string {
  const folded = s.normalize("NFC").replace(SLASH_LIKE, "/").replace(/\/+$/, "");
  return CASE_INSENSITIVE ? folded.toLowerCase() : folded;
}

function pathMatches(a: string, b: string): boolean {
  return foldKey(a) === foldKey(b);
}

/** Fold a destination-relative path so collision keys follow platform case rules. */
function claimKey(dir: string, name: string): string {
  return foldKey(path.join(dir === "." ? "" : dir, name));
}

/**
 * Mark convert decisions whose output path would collide with a sibling.
 *
 * Copies keep their original filename, so they claim that name; a convert that
 * maps onto the same path gets its source extension appended, e.g.
 * `CLIP.MOV` -> `CLIP-mov.mp4`. Storing the suffix on the decision keeps run,
 * sync, and estimate in agreement.
 */
function annotateVideoCollisions(
  convert: VideoDecision[],
  copy: VideoDecision[],
  targetExt: string,
): void {
  const claims = [
    ...convert.map((d) => {
      const ext = path.extname(d.file.name);
      const base = ext ? d.file.name.slice(0, -ext.length) : d.file.name;
      return {
        d,
        key: claimKey(d.file.dir, `${base}.${targetExt}`),
        ext: d.file.ext || extOf(d.file.name),
      };
    }),
    ...copy.map((d) => ({
      d,
      key: claimKey(d.file.dir, d.file.name),
      ext: d.file.ext || extOf(d.file.name),
    })),
  ];

  const counts = new Map<string, number>();
  for (const c of claims) counts.set(c.key, (counts.get(c.key) ?? 0) + 1);

  for (const c of claims) {
    if (c.d.verdict === "convert" && (counts.get(c.key) ?? 0) > 1) {
      c.d.outStemSuffix = `-${c.ext}`;
    }
  }
}

function longestMatchingFolder(rules: string[], dir: string): number {
  if (!dir || dir === ".") return -1;
  const normDir = foldKey(dir);
  let maxLen = -1;
  for (const r of rules) {
    if (!r) continue;
    const normRule = foldKey(r);
    if (normDir === normRule || normDir.startsWith(normRule + "/")) {
      if (normRule.length > maxLen) maxLen = normRule.length;
    }
  }
  return maxLen;
}

function fileInRules(rules: string[], rel: string): boolean {
  return rules.some((r) => pathMatches(rel, r));
}

function classifyVideo(
  file: ScannedFile,
  policy: VideoPolicy,
): { verdict: VideoVerdict; reason: string } {
  const rel = file.rel;
  const dir = file.dir === "." ? "" : file.dir;

  if (fileInRules(policy.includedFiles, rel)) {
    // Included explicitly
  } else if (fileInRules(policy.excludedFiles, rel)) {
    return { verdict: "skip", reason: "file-excluded" };
  } else {
    const incLen = longestMatchingFolder(policy.includedFolders, dir);
    const exLen = longestMatchingFolder(policy.excludedFolders, dir);
    if (exLen > -1 && exLen > incLen) {
      return { verdict: "skip", reason: "folder-excluded" };
    }
  }

  const ext = file.ext || extOf(file.name);
  if (policy.extEnabled[ext] === false) {
    return { verdict: "skip", reason: "ext-disabled" };
  }

  if (file.size < policy.minSizeBytes) {
    return policy.copyUndersized
      ? { verdict: "copy", reason: "undersized" }
      : { verdict: "skip", reason: "undersized-dropped" };
  }

  return { verdict: "convert", reason: "ok" };
}

export function applyVideoPolicy(
  scan: ScanResult,
  policyInput?: Partial<VideoPolicy>,
  ratio?: number,
): VideoPreview {
  const policy = normaliseVideoPolicy(policyInput);
  const effectiveRatio = ratio ?? VIDEO_FORMAT_SPECS[policy.outputFormat].defaultRatio;

  const convert: VideoDecision[] = [];
  const copy: VideoDecision[] = [];
  const skip: VideoDecision[] = [];

  for (const file of scan.files) {
    const ext = file.ext || extOf(file.name);
    // Ignore non-video files completely so the video preview plans strictly videos
    if (file.category !== "video" && !(VIDEO_EXTS as readonly string[]).includes(ext)) {
      continue;
    }

    const { verdict, reason } = classifyVideo(file, policy);
    const d: VideoDecision = { file, verdict, reason };
    if (verdict === "convert") convert.push(d);
    else if (verdict === "copy") copy.push(d);
    else skip.push(d);
  }

  const outExt = policy.outputFormat === "vp9" ? "webm" : policy.container;
  annotateVideoCollisions(convert, copy, outExt);

  const convertBytes = convert.reduce((a, d) => a + d.file.size, 0);
  const copyBytes = copy.reduce((a, d) => a + d.file.size, 0);
  const estOutputBytes = Math.round(convertBytes * effectiveRatio + copyBytes);
  const estOutputFiles = convert.length + copy.length;

  const folderMap = new Map<
    string,
    { convertCount: number; copyCount: number; convertBytes: number; copyBytes: number }
  >();

  const bump = (d: VideoDecision, key: "convert" | "copy", bytes: number) => {
    const top = d.file.dir === "." || !d.file.dir ? "(root)" : relTop(d.file.rel);
    const e = folderMap.get(top) ?? {
      convertCount: 0,
      copyCount: 0,
      convertBytes: 0,
      copyBytes: 0,
    };
    if (key === "convert") {
      e.convertCount++;
      e.convertBytes += bytes;
    } else {
      e.copyCount++;
      e.copyBytes += bytes;
    }
    folderMap.set(top, e);
  };

  for (const d of convert) bump(d, "convert", d.file.size);
  for (const d of copy) bump(d, "copy", d.file.size);

  const byFolder = [...folderMap.entries()]
    .map(([rel, e]) => ({
      rel,
      convertCount: e.convertCount,
      copyCount: e.copyCount,
      convertBytes: e.convertBytes,
      copyBytes: e.copyBytes,
      estOutputBytes: Math.round(e.convertBytes * effectiveRatio + e.copyBytes),
    }))
    .sort((a, b) => b.estOutputBytes - a.estOutputBytes);

  return {
    convert,
    copy,
    skip,
    sourceBytes: convertBytes + copyBytes,
    estOutputBytes,
    estOutputFiles,
    compressionRatio: effectiveRatio,
    byFolder,
  };
}
