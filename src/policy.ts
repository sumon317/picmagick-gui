/**
 * Turns the user's selections into a concrete work list.
 *
 * Every file lands in exactly one bucket:
 *   convert  re-encode to the selected output format
 *   copy     place verbatim into the output tree (preserves the original bytes)
 *   skip     leave alone
 */
import path from "node:path";
import type { ScannedFile, ScanResult } from "./scan.ts";
import { CONVERT_EXTS, RAW_EXTS, extOf } from "./paths.ts";
import { CASE_INSENSITIVE, relTop } from "./platform.ts";
import {
  DEFAULT_FORMAT, FORMAT_SPECS, isOutputFormat, type OutputFormat,
} from "./formats.ts";

export type Policy = {
  /** Folder rel-paths that are fully excluded. */
  excludedFolders: string[];
  /**
   * Folders pulled back in despite an excluded ancestor.
   *
   * Exclusion is prefix-based, so "exclude backup" would otherwise swallow
   * every child too. Without this override, re-including one subfolder would
   * silently drop the parent's exclusion and put thousands of files back into
   * the run. Include always wins.
   */
  includedFolders: string[];
  /**
   * Individual file rel-paths to skip. These are more specific than any
   * folder rule, so a file can be dropped without excluding its folder.
   */
  excludedFiles: string[];
  /**
   * Individual file rel-paths to keep despite an excluded folder. Like
   * includedFolders, an explicit include always wins.
   */
  includedFiles: string[];
  /** Explicit per-extension switches. Anything absent is off. */
  extEnabled: Record<string, boolean>;
  /** Skip source files smaller than this many bytes (converted or not). */
  minSizeBytes: number;
  /** When a file falls below minSizeBytes, copy it verbatim instead of dropping it. */
  copyUndersized: boolean;
  includeRaw: boolean;
  /** Selected output encoder. AVIF remains the default. */
  outputFormat: OutputFormat;
  /** Several qualities produce name-qNN.<ext>; one produces name.<ext>. */
  qualities: number[];
  flattenGif: boolean;
  heicSpeed: number;
  /** Long-edge pixel cap (0 = original resolution). */
  maxResolution?: number;
  /** Copy original bytes if a single-quality converted file is >= original size. */
  skipAlreadyEfficient?: boolean;
  /** Strip EXIF/GPS metadata (-strip). */
  stripMetadata?: boolean;
};

export const DEFAULT_POLICY: Policy = {
  excludedFolders: [],
  includedFolders: [],
  excludedFiles: [],
  includedFiles: [],
  extEnabled: Object.fromEntries(CONVERT_EXTS.map((e) => [e, true])),
  minSizeBytes: 0,
  copyUndersized: true,
  includeRaw: false,
  outputFormat: DEFAULT_FORMAT,
  qualities: [60],
  flattenGif: false,
  // Typical measurements (three sample photos, q60):
  //   speed 5 -> 18.2s / 923 KB      speed 6 -> 4.6s / 1029 KB
  //   speed 8 ->  2.5s / 1048 KB     speed 10 -> FAILS, writes a 0-byte file
  // 6 is the knee: ~4x faster than 5 for ~12% more bytes.
  heicSpeed: 6,
  maxResolution: 0,
  skipAlreadyEfficient: true,
  stripMetadata: false,
};

export type Verdict = "convert" | "copy" | "skip";
export type Reason =
  | "ok"
  | "folder-excluded"
  | "ext-disabled"
  | "raw-disabled"
  | "video-out-of-scope"
  | "undersized"
  | "undersized-dropped";

export type Decision = {
  file: ScannedFile;
  verdict: Verdict;
  reason: Reason;
  /**
   * Appended to the output stem when a sibling in the same folder would
   * otherwise land on the identical output path (`IMG_001.JPG` +
   * `IMG_001.HEIC` -> `IMG_001-jpg.avif` + `IMG_001-heic.avif`).
   */
  outStemSuffix?: string;
};

export type Preview = {
  convert: Decision[];
  copy: Decision[];
  skip: Decision[];
  sourceBytes: number;      // bytes of files that will be read
  estOutputBytes: number;   // projected size of the output tree
  estOutputFiles: number;
  /** Estimate is only as good as the ratio it was given. */
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

/**
 * Typical measurement (61 sample files): q60 AVIF lands at ~17.4% of source.
 * Refine with estimate.ts once a real sample has been converted.
 */
export const DEFAULT_RATIO = 0.174;

export function normalisePolicy(p: Partial<Policy> | undefined): Policy {
  const base = { ...DEFAULT_POLICY, ...(p ?? {}) };
  const extEnabled: Record<string, boolean> = {};
  for (const ext of CONVERT_EXTS) {
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
  return {
    ...base,
    extEnabled,
    outputFormat: isOutputFormat(base.outputFormat) ? base.outputFormat : DEFAULT_FORMAT,
    excludedFolders: cleanFolders(base.excludedFolders),
    includedFolders: cleanFolders(base.includedFolders),
    excludedFiles: cleanFiles(base.excludedFiles),
    includedFiles: cleanFiles(base.includedFiles),
    qualities: (base.qualities ?? [60]).filter((q) => Number.isFinite(q) && q > 0),
    minSizeBytes: Math.max(0, base.minSizeBytes ?? 0),
    // aom accepts 0-10, but 10 exits 0 while writing an empty file.
    heicSpeed: Math.max(0, Math.min(9, base.heicSpeed ?? 6)),
    maxResolution: [0, 5120, 3840, 2560, 1920].includes(Number(base.maxResolution))
      ? Number(base.maxResolution)
      : 0,
    skipAlreadyEfficient: base.skipAlreadyEfficient !== false,
    stripMetadata: Boolean(base.stripMetadata),
  };
}

/**
 * Path comparison has to survive Unicode drift.
 *
 * A folder name can contain
 *   "album 2025<U+2044>11<U+2044>23"
 * where the separators are FRACTION SLASH, not ASCII '/'. They render almost
 * identically, so anyone who types the name by hand - or copies it through a
 * tool that normalises Unicode - silently gets a different string.
 *
 * Folding to NFC plus one slash character means such a mismatch surfaces as
 * "excluded", which is visible, rather than "converted anyway", which is not.
 */
const SLASH_LIKE = /[\u002F\u005C\u2044\u2215\u29F5\u29F8\uFF0F\uFF3C]/g;

function foldKey(s: string): string {
  const folded = s
    .normalize("NFC")
    .replace(SLASH_LIKE, "/")
    .replace(/\/+$/, "");
  return CASE_INSENSITIVE ? folded.toLowerCase() : folded;
}

const under = (rel: string, dir: string, norm: string) =>
  dir === norm || dir.startsWith(norm + "/") || rel.startsWith(norm + "/");

/**
 * Include overrides exclude. Without that, excluding a parent would make its
 * children unreachable - you could not put one back without losing the parent's
 * exclusion, which is exactly the kind of silent mistake a backup tool must not
 * make.
 *
 * File-level rules are checked first because they are the most specific thing
 * the user can say. An included file comes back even inside an excluded folder;
 * an excluded file stays out even inside an included one.
 */
function isExcluded(file: ScannedFile, policy: Policy): boolean {
  const rel = foldKey(file.rel);
  const dir = foldKey(file.dir);

  for (const inc of policy.includedFiles) {
    if (inc && foldKey(inc) === rel) return false;
  }
  for (const ex of policy.excludedFiles) {
    if (ex && foldKey(ex) === rel) return true;
  }

  let longestMatchLen = -1;
  let isEx = false;

  for (const inc of policy.includedFolders) {
    if (!inc) continue;
    const f = foldKey(inc);
    if (under(rel, dir, f) && f.length > longestMatchLen) {
      longestMatchLen = f.length;
      isEx = false;
    }
  }

  for (const ex of policy.excludedFolders) {
    if (!ex) continue;
    const f = foldKey(ex);
    if (under(rel, dir, f) && f.length > longestMatchLen) {
      longestMatchLen = f.length;
      isEx = true;
    }
  }

  return isEx;
}

export function classify(file: ScannedFile, policy: Policy): { verdict: Verdict; reason: Reason } {
  if (isExcluded(file, policy)) {
    return { verdict: "skip", reason: "folder-excluded" };
  }

  const ext = file.ext || extOf(file.name);

  // RAW is gated on its own switch regardless of the per-extension table,
  // because enabling .arw there is a far more tempting mistake.
  if ((RAW_EXTS as readonly string[]).includes(ext)) {
    if (!policy.includeRaw) return { verdict: "skip", reason: "raw-disabled" };
    return classifyBySize(file, policy);
  }

  if (!(CONVERT_EXTS as readonly string[]).includes(ext)) {
    // Includes video and junk: both out of scope.
    return { verdict: "skip", reason: "video-out-of-scope" };
  }

  if (!policy.extEnabled[ext]) return { verdict: "skip", reason: "ext-disabled" };

  return classifyBySize(file, policy);
}

function classifyBySize(file: ScannedFile, policy: Policy): { verdict: Verdict; reason: Reason } {
  if (file.size < policy.minSizeBytes) {
    return policy.copyUndersized
      ? { verdict: "copy", reason: "undersized" }
      : { verdict: "skip", reason: "undersized-dropped" };
  }
  return { verdict: "convert", reason: "ok" };
}

/**
 * Mark convert decisions whose output path would collide with a sibling.
 *
 * Copies always keep their original filename, so they claim that name; a
 * convert that maps onto the same path gets its source extension appended,
 * e.g. `IMG_001.HEIC` -> `IMG_001-heic.avif`. The suffix is stored on the
 * decision so run, estimate, and sync all compute the same path.
 */
function annotateCollisions(
  convert: Decision[],
  copy: Decision[],
  targetExt: string,
): void {
  const claim = (d: Decision, name: string): { d: Decision; key: string; ext: string } => {
    const dir = d.file.dir === "." ? "" : d.file.dir;
    return {
      d,
      key: foldKey(path.join(dir, name)),
      ext: d.file.ext || extOf(d.file.name),
    };
  };

  const claims = [
    ...convert.map((d) => {
      const stem = path.basename(d.file.name, path.extname(d.file.name));
      return claim(d, `${stem}.${targetExt}`);
    }),
    ...copy.map((d) => claim(d, d.file.name)),
  ];

  const counts = new Map<string, number>();
  for (const c of claims) counts.set(c.key, (counts.get(c.key) ?? 0) + 1);

  for (const c of claims) {
    if (c.d.verdict === "convert" && (counts.get(c.key) ?? 0) > 1) {
      c.d.outStemSuffix = `-${c.ext}`;
    }
  }
}

export function applyPolicy(
  scan: ScanResult,
  policyInput: Partial<Policy>,
  ratio = DEFAULT_RATIO,
): Preview {
  const policy = normalisePolicy(policyInput);
  const convert: Decision[] = [];
  const copy: Decision[] = [];
  const skip: Decision[] = [];

  for (const file of scan.files) {
    const { verdict, reason } = classify(file, policy);
    if (verdict === "convert") convert.push({ file, verdict, reason });
    else if (verdict === "copy") copy.push({ file, verdict, reason });
    else skip.push({ file, verdict, reason });
  }

  annotateCollisions(convert, copy, FORMAT_SPECS[policy.outputFormat].ext);

  const convertBytes = convert.reduce((a, d) => a + d.file.size, 0);
  const copyBytes = copy.reduce((a, d) => a + d.file.size, 0);
  const variants = Math.max(1, policy.qualities.length);
  // Copied files land at their original size. Converted files land at ratio,
  // multiplied by the number of quality variants being produced.
  const estOutputBytes = Math.round(convertBytes * ratio * variants + copyBytes);
  const estOutputFiles = convert.length * variants + copy.length;

  const folderMap = new Map<string, {
    convertCount: number; copyCount: number; convertBytes: number; copyBytes: number;
  }>();
  const bump = (rel: string, key: "convert" | "copy", bytes: number) => {
    const top = relTop(rel);
    const e = folderMap.get(top) ?? { convertCount: 0, copyCount: 0, convertBytes: 0, copyBytes: 0 };
    if (key === "convert") { e.convertCount++; e.convertBytes += bytes; }
    else { e.copyCount++; e.copyBytes += bytes; }
    folderMap.set(top, e);
  };
  for (const d of convert) bump(d.file.rel, "convert", d.file.size);
  for (const d of copy) bump(d.file.rel, "copy", d.file.size);

  const byFolder = [...folderMap.entries()]
    .map(([rel, e]) => ({
      rel,
      convertCount: e.convertCount,
      copyCount: e.copyCount,
      convertBytes: e.convertBytes,
      copyBytes: e.copyBytes,
      estOutputBytes: Math.round(e.convertBytes * ratio * variants + e.copyBytes),
    }))
    .sort((a, b) => b.estOutputBytes - a.estOutputBytes);

  return {
    convert, copy, skip,
    sourceBytes: convertBytes + copyBytes,
    estOutputBytes,
    estOutputFiles,
    compressionRatio: ratio,
    byFolder,
  };
}

/** Destination path for a decided file, honouring the mirrored layout. */
export function outputPathFor(
  d: Decision,
  sourceRoot: string,
  destination: string,
  policy: Policy,
  quality?: number,
): string {
  const relDir = d.file.dir;

  // Copy means "preserve the original bytes". It must also preserve the
  // original filename/extension; renaming a copied JPEG to .avif/.webp/.jxl
  // makes the output lie about its contents.
  if (d.verdict === "copy") {
    return relDir && relDir !== "."
      ? path.join(destination, relDir, d.file.name)
      : path.join(destination, d.file.name);
  }

  const spec = FORMAT_SPECS[policy.outputFormat];
  const rawStem = path.basename(d.file.name, path.extname(d.file.name));
  const stem = `${rawStem}${d.outStemSuffix ?? ""}`;
  const multi = policy.qualities.length > 1;
  const name = multi
    ? `${stem}-q${quality ?? policy.qualities[0]}.${spec.ext}`
    : `${stem}.${spec.ext}`;
  return relDir && relDir !== "."
    ? path.join(destination, relDir, name)
    : path.join(destination, name);
}

export function summariseReasons(preview: Preview): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of [...preview.convert, ...preview.copy, ...preview.skip]) {
    out[d.reason] = (out[d.reason] ?? 0) + 1;
  }
  return out;
}