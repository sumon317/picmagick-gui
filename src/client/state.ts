/**
 * Shared mutable state for the browser client.
 *
 * Kept in one module so the full-screen views can read the same run, scan, and
 * preview facts without passing a dozen arguments. Every write still happens
 * through main.ts or a view controller; this object is not a store with
 * subscriptions, just the app's current truth.
 */
import type {
  AppUpdateStatus,
  CompareResponse,
  Estimate,
  FileResult,
  FormatSpec,
  JobState,
  JobSummary,
  OutputFormat,
  PreviewResponse,
  ScanResult,
  Status,
  SyncResponse,
  TreeNode,
  UpdateStatus,
  VideoStatusResponse,
} from "./types";

export type ViewName = "workspace" | "run" | "compare" | "runs" | "health";

export type FormatMemory = Record<string, { quality: number; speed: number }>;

export type RunState = {
  id: string | null;
  state: JobState;
  total: number;
  done: number;
  converted: number;
  copied: number;
  skipped: number;
  failed: number;
  bytes: number;
  inBytes?: number;
  etaSeconds: number | null;
  elapsedSeconds: number | null;
  inFlight: number;
  startingRel: string | null;
  startingBytes: number | null;
  lastRel: string | null;
  lastStatus: string | null;
  /** Transient shell message (pausing, reconnecting, cancelling). */
  note: string | null;
};

export type AppState = {
  status: Status | null;
  tree: TreeNode | null;
  lastScan: ScanResult | null;

  excluded: Set<string>;
  included: Set<string>;
  excludedFiles: Set<string>;
  includedFiles: Set<string>;
  expanded: Set<string>;
  filterQuery: string;

  formatSpecs: Record<string, FormatSpec>;
  currentFormat: OutputFormat;
  formatMemory: FormatMemory;

  preview: PreviewResponse | null;
  previewSeq: number;
  previewBusy: boolean;

  run: RunState;
  currentJob: string | null;
  lastJobId: string | null;
  lastSummary: JobSummary | null;
  lastManifestId: string | null;
  lastJobError: string | null;
  activity: FileResult[];
  failedActivity: FileResult[];
  running: boolean;
  starting: boolean;
  es: EventSource | null;

  imStatus: UpdateStatus | null;
  appUpdate: AppUpdateStatus | null;
  lastEstimate: Estimate | null;
  lastSync: SyncResponse | null;

  view: ViewName;
  compareRel: string | null;
  compare: CompareResponse | null;
  compareVariant: number;
  compareMode: "split" | "side" | "toggle";
  compareZoom: number;
  compareShowOriginal: boolean;

  themeChoice: string;
  booted: boolean;

  mediaMode: "image" | "video";
  videoDestMode: "merge" | "subfolder" | "custom";
  videoCustomDestination: string;
  videoStatus: VideoStatusResponse | null;
};

const emptyRun = (): RunState => ({
  id: null,
  state: "idle",
  total: 0,
  done: 0,
  converted: 0,
  copied: 0,
  skipped: 0,
  failed: 0,
  bytes: 0,
  inBytes: 0,
  etaSeconds: null,
  elapsedSeconds: null,
  inFlight: 0,
  startingRel: null,
  startingBytes: null,
  lastRel: null,
  lastStatus: null,
  note: null,
});

export const state: AppState = {
  status: null,
  tree: null,
  lastScan: null,

  excluded: new Set(),
  included: new Set(),
  excludedFiles: new Set(),
  includedFiles: new Set(),
  expanded: new Set(),
  filterQuery: "",

  formatSpecs: {},
  currentFormat: "avif",
  formatMemory: {},

  preview: null,
  previewSeq: 0,
  previewBusy: false,

  run: emptyRun(),
  currentJob: null,
  lastJobId: null,
  lastSummary: null,
  lastManifestId: null,
  lastJobError: null,
  activity: [],
  failedActivity: [],
  running: false,
  starting: false,
  es: null,

  imStatus: null,
  appUpdate: null,
  lastEstimate: null,
  lastSync: null,

  view: "workspace",
  compareRel: null,
  compare: null,
  compareVariant: 0,
  compareMode: "split",
  compareZoom: 0,
  compareShowOriginal: true,

  themeChoice: "auto",
  booted: false,

  mediaMode: "image",
  videoDestMode: "merge",
  videoCustomDestination: "",
  videoStatus: null,
};

export const resetRun = (total: number): void => {
  state.run = { ...emptyRun(), total, state: "running" };
  state.activity = [];
  state.failedActivity = [];
  state.lastSummary = null;
  state.lastManifestId = null;
  state.lastJobError = null;
  state.lastJobId = null;
};
