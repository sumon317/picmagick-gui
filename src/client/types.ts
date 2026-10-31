/**
 * Browser-facing types for the Compakta API.
 *
 * Field names mirror src/server.ts and the domain modules exactly. The UI never
 * invents conversion facts; every value here comes from the local server.
 */

export type OutputFormat =
  | "jxl"
  | "avif"
  | "webp"
  | "heic"
  | "jp2"
  | "jpeg"
  | "png"
  | "av1"
  | "hevc"
  | "av1_hw"
  | "hevc_hw"
  | "vp9";

export type Category = "image" | "raw" | "video" | "other";

export const CONVERT_EXTS = [
  "jpg", "jpeg", "jpe", "jfif", "heic", "heif", "png", "bmp", "tif", "tiff", "webp", "gif",
] as const;

export const VIDEO_EXTS = [
  "mp4", "mov", "m4v", "avi", "mkv", "3gp", "mts", "m2ts", "webm", "mpg", "mpeg", "wmv", "flv", "ogv",
] as const;

export type FormatSupport = {
  mode: string;
  writable: boolean;
  detail: string | null;
};

export type MagickInfo = {
  path: string;
  version: string;
  formats: Record<OutputFormat, FormatSupport>;
  avifMode?: string;
  avifWritable: boolean;
  libheif: string | null;
};

export type QualitySpec = {
  kind: "lossy" | "compression" | "rate" | "crf-inverted";
  min: number;
  max: number;
  step: number;
  default: number;
  label: string;
  hint: string;
  note: string;
  rateTable?: Record<string, number>;
};

export type SpeedSpec = {
  min: number;
  max: number;
  step: number;
  default: number;
  label: string;
  hint: string;
  note: string;
  visible: boolean;
  labels: Record<string, string>;
};

export type FormatSpec = {
  id: OutputFormat;
  label: string;
  shortLabel: string;
  summary: string;
  ext: string;
  destinationSuffix: string;
  mime: string;
  magickPrefix: string;
  quality: QualitySpec;
  speed: SpeedSpec;
  defaultRatio: number;
  compareQualities: number[];
  supportsAnimation: boolean;
  supportsTransparency: boolean;
  transparencyNote: string;
  animationNote: string;
};

export type Policy = {
  excludedFolders: string[];
  includedFolders: string[];
  excludedFiles: string[];
  includedFiles: string[];
  extEnabled: Record<string, boolean>;
  minSizeBytes: number;
  copyUndersized: boolean;
  includeRaw: boolean;
  outputFormat: OutputFormat;
  qualities: number[];
  flattenGif: boolean;
  heicSpeed: number;
  maxResolution?: number;
  skipAlreadyEfficient?: boolean;
  stripMetadata?: boolean;
};

export type ScannedFile = {
  abs: string;
  rel: string;
  dir: string;
  name: string;
  ext: string;
  size: number;
  category: Category;
  mtime: number;
};

export type TreeNode = {
  name: string;
  rel: string;
  path: string;
  depth: number;
  children: TreeNode[];
  files: ScannedFile[];
  count: number;
  bytes: number;
  imageCount: number;
  imageBytes: number;
  rawCount: number;
  rawBytes: number;
  videoCount: number;
  videoBytes: number;
  otherCount: number;
  otherBytes: number;
};

export type ScanTotals = {
  count: number;
  bytes: number;
  imageCount: number;
  imageBytes: number;
  rawCount: number;
  rawBytes: number;
  videoCount: number;
  videoBytes: number;
  otherCount: number;
  otherBytes: number;
};

export type ScanResult = {
  ok: true;
  durationMs: number;
  tree: TreeNode;
  totals: ScanTotals;
  deadFolders: string[];
  riskyNames: { rel: string; reason: string }[];
  skipped: { path: string; reason: string }[];
  projects: string[];
};

export type Status = {
  sourceRoot: string;
  destination: string;
  pathSeparator: string;
  caseInsensitive: boolean;
  platform: string;
  arch: string;
  canPickFolder: boolean;
  budgetBytes: number;
  ratio: number;
  ratios: Record<OutputFormat, number>;
  outputFormat: OutputFormat;
  formats: FormatSpec[];
  policy: Policy;
  scanned: boolean;
  scannedAt: number | null;
  fileCount: number;
  freeBytes: number | null;
  freeLabel: string;
  magick: {
    version: string;
    path: string;
    avifWritable: boolean;
    libheif: string | null;
    formats: Record<OutputFormat, FormatSupport>;
  } | null;
  liveJobId: string | null;
  pausedJobId: string | null;
  redundantRoots: string[];
  projects: string[];
};

export type HealthCheck = {
  id: string;
  label: string;
  status: "ok" | "warn" | "fail";
  detail: string;
};

export type HealthReport = {
  checks: HealthCheck[];
  magick: MagickInfo | null;
  canRun: boolean;
  freeBytes: number | null;
};

export type BudgetDropSuggestion = {
  rel: string;
  estOutputBytes: number;
  runningTotalAfterDrop: number;
  getsUnderBudget: boolean;
};

export type BudgetFolder = {
  rel: string;
  convertCount: number;
  copyCount: number;
  estOutputBytes: number;
  sourceBytes: number;
  density: number;
  share: number;
};

export type BudgetPlan = {
  budgetBytes: number;
  fits: boolean;
  totalEstBytes: number;
  overBy: number;
  dropSuggestions: BudgetDropSuggestion[];
  addSuggestions: { rel: string; estOutputBytes: number; estAfterAdd: number }[];
  perFolder: BudgetFolder[];
};

export type FolderRollup = {
  rel: string;
  convertCount: number;
  copyCount: number;
  convertBytes: number;
  copyBytes: number;
  estOutputBytes: number;
};

export type PreviewResponse = {
  convert: number;
  copy: number;
  skip: number;
  sourceBytes: number;
  estOutputBytes: number;
  estOutputFiles: number;
  ratio: number;
  outputFormat: OutputFormat;
  formatLabel: string;
  byFolder: FolderRollup[];
  budget: BudgetPlan;
  health: HealthReport;
  freeBytes: number | null;
  otherModeBytes?: number;
  otherModeCount?: number;
};

export type Estimate = {
  sampleSize: number;
  sampledBytes: number;
  producedBytes: number;
  ratio: number;
  meanOutputBytes: number;
  secondsPerImage: number;
  projectedOutputBytes: number;
  projectedSeconds: number;
  totalConvert: number;
  totalConvertBytes: number;
  method: "sampled" | "flat";
  durationMs: number;
  format: OutputFormat;
};

export type SyncEntry = {
  rel: string;
  out: string | null;
  state: "new" | "changed" | "upToDate";
  sourceBytes: number;
  outputBytes: number | null;
  reason?: string;
};

export type SyncResponse = {
  total: number;
  newCount: number;
  changedCount: number;
  upToDateCount: number;
  pendingCount: number;
  pendingSourceBytes: number;
  orphanCount: number;
  orphanBytes: number;
  orphans: { out: string; bytes: number }[];
  estOutputBytes: number;
  outputFormat: OutputFormat;
  durationMs: number;
  changed: SyncEntry[];
  sampleNew: SyncEntry[];
};

export type DuplicateGroup = {
  hash: string;
  size: number;
  members: { rel: string; abs: string; size: number; category: string }[];
  spreadAcrossFolders: boolean;
};

export type DuplicatesResponse = {
  groups: DuplicateGroup[];
  groupCount: number;
  duplicateFiles: number;
  duplicateBytes: number;
  hashedFiles: number;
  durationMs: number;
};

export type DatesResponse = {
  total: number;
  withExif: number;
  fromNameOnly: number;
  undated: string[];
  byYear: Record<string, number>;
  scanned: number;
  inScope: number;
  truncated: boolean;
  omitted: number;
};

export type FileResult = {
  rel: string;
  src: string;
  out: string | null;
  status: "converted" | "copied" | "skipped" | "failed" | "cancelled";
  seconds: number;
  inBytes: number;
  outBytes: number;
  error?: string;
  partialErrors?: string[];
};

export type ProgressEvent = {
  type: "hello" | "start" | "progress" | "log" | "finish" | "error" | "paused" | "resumed";
  at?: number;
  jobId?: string;
  state?: JobState;
  total?: number;
  done?: number;
  converted?: number;
  copied?: number;
  skipped?: number;
  failed?: number;
  bytes?: number;
  etaSeconds?: number;
  elapsedSeconds?: number;
  file?: FileResult;
  starting?: { rel: string; bytes: number };
  inFlight?: number;
  summary?: JobSummary;
  message?: string;
  manifestId?: string;
  remaining?: number;
  note?: string;
};

export type JobState = "idle" | "running" | "paused" | "done" | "cancelled" | "failed";

export type JobSummary = {
  total: number;
  done: number;
  converted: number;
  copied: number;
  skipped: number;
  failed: number;
  bytes: number;
  remaining: number;
  elapsedSeconds: number;
  note?: string;
};

export type RunResponse = {
  jobId: string;
  total: number;
  jobs: number;
  cpuLimit?: number;
  outputFormat: OutputFormat;
};

export type JobSnapshot = {
  id: string;
  state: JobState;
  done: number;
  total: number;
  remaining: number;
  converted: number;
  copied: number;
  skipped: number;
  failed: number;
  bytes: number;
  jobs: number;
  cpuLimit?: number;
  inFlight: number;
};

export type CompareVariant = {
  quality: number;
  label: string;
  url: string;
  bytes: number;
};

export type CompareResponse = {
  rel: string;
  format: OutputFormat;
  formatLabel: string;
  originalUrl: string;
  originalBytes: number;
  originalExt?: string;
  mtime?: number;
  durationSec?: number;
  timestampSec?: number;
  variants: CompareVariant[];
  errors: string[];
};

export type VerifyRow = {
  rel: string;
  out: string;
  ok: boolean;
  problems: string[];
  srcWidth?: number;
  srcHeight?: number;
  outWidth?: number;
  outHeight?: number;
  bytes?: number;
  dateKept?: boolean;
};

export type VerifyResponse = {
  checked: number;
  passed: number;
  failed: number;
  dateSurvived: number;
  durationMs: number;
  rows: VerifyRow[];
};

export type ManifestSummary = {
  converted: number;
  copied: number;
  skipped: number;
  failed: number;
  bytes: number;
};

export type ManifestItem = {
  id: string;
  createdAt: number;
  summary: ManifestSummary;
  quality: number[];
  outputFormat: OutputFormat;
  destination: string;
};

export type ManifestsResponse = {
  manifests: ManifestItem[];
};

export type UndoResult = {
  removed: number;
  missing: number;
  bytesFreed: number;
  refused: number;
  errors: string[];
};

export type InstallProgress = {
  running: boolean;
  stage: "idle" | "downloading" | "extracting" | "verifying" | "installing" | "done" | "error";
  message: string;
  percent: number;
  version: string | null;
  error: string | null;
};

export type LatestRelease = {
  version: string;
  tag: string;
  publishedAt: string;
  pageUrl: string;
  asset: { name: string; size: number; url: string; digest: string | null };
  kind: "portable" | "appimage";
};

export type UpdateStatus = {
  installed: {
    version: string;
    path: string;
    avifWritable: boolean;
    libheif: string | null;
  } | null;
  installDir: string;
  online: boolean;
  latest: LatestRelease | null;
  updateAvailable: boolean;
  supported: boolean;
  assetKind: "portable" | "appimage";
  managed: boolean;
  checkedAt: number | null;
  error: string | null;
  install: InstallProgress;
};

export type AppUpdateStage =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "error";

export type AppUpdateStatus = {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  stage: AppUpdateStage;
  message: string;
  percent: number;
  downloadedBytes: number;
  totalBytes: number;
  releaseNotes: string | null;
  releaseUrl: string | null;
  assetName: string | null;
  installerPath: string | null;
  checkedAt: number | null;
  error: string | null;
  isDesktop: boolean;
};

export type VideoDestMode = "merge" | "subfolder" | "custom";

export type VideoPolicy = {
  excludedFolders: string[];
  includedFolders: string[];
  excludedFiles: string[];
  includedFiles: string[];
  extEnabled: Record<string, boolean>;
  minSizeBytes: number;
  copyUndersized: boolean;
  destMode: VideoDestMode;
  outputFormat: OutputFormat;
  container: string;
  quality: number;
  speed: number;
  maxResolution: number;
  maxFps: number;
  audioMode: string;
  tenBit: boolean;
  filmGrain: number;
  skipAlreadyEfficient: boolean;
  customParams: string;
};
