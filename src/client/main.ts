/**
 * Browser entrypoint.
 *
 * This is the only module that mutates server policy. Views ask for actions
 * through the small ViewActions contract; the API remains the source of every
 * count, byte total, and support decision.
 */
import { api } from "./api";
import {
  $,
  clamp,
  closeModal,
  count,
  debounce,
  dur,
  escapeHtml,
  fmt,
  icon,
  input,
  middlePath,
  modKey,
  openModal,
  shortVersion,
  setWidth,
  toast,
} from "./dom";
import { nextDestinationOnFormatChange } from "./format-logic";
import { createFormatUi, type FormatUi } from "./format-ui";
import { createLibrary, type LibraryController } from "./library";
import { createLightbox, type LightboxController } from "./lightbox";
import { createPlan, type PlanController } from "./plan";
import { createRunLifecycle, type RunLifecycle } from "./run-lifecycle";
import { initSplitPanes } from "./split-panes";
import { initMicrointeractions } from "./microinteractions";
import { state } from "./state";
import {
  CONVERT_EXTS,
  VIDEO_EXTS,
  type AppUpdateStatus,
  type CompareResponse,
  type Estimate,
  type HealthReport,
  type InstallProgress,
  type JobSnapshot,
  type ManifestSummary,
  type OutputFormat,
  type Policy,
  type PreviewResponse,
  type ScannedFile,
  type ScanResult,
  type Status,
  type UndoResult,
  type UpdateStatus,
  type VerifyResponse,
  type VideoPolicy,
} from "./types";
import { createAuditView, type AuditViewController } from "./views/audit";
import { createCompareView, type CompareViewController } from "./views/compare";
import { createHealthView, type HealthViewController } from "./views/health";
import { createRunView, type RunViewController } from "./views/run";
import { createRunsView, type RunsViewController } from "./views/runs";
import type { ConfirmOptions, ViewActions } from "./views/shared";
import { APP_VERSION } from "../version";

// --------------------------------------------------------------------------
// Local response shapes
// --------------------------------------------------------------------------

type ValidateResponse =
  | { ok: true; exists: boolean; isDirectory: boolean }
  | { ok: false; error: string };

type PickResponse = { path: string | null };

type ConfigResponse = {
  ok: true;
  sourceRoot: string;
  destination: string;
  needsScan: boolean;
};

type InstallResponse = {
  ok: true;
  version: string;
  folder: string;
};

const THEME_IDS = ["midnight", "daylight", "ink", "sepia", "nord", "rose"] as const;
type ThemeId = (typeof THEME_IDS)[number];
type ThemeChoice = ThemeId | "auto";

// --------------------------------------------------------------------------
// Module state
// --------------------------------------------------------------------------

let library: LibraryController;
let formatUi: FormatUi;
let plan: PlanController;
let runLifecycle: RunLifecycle;
let runView: RunViewController;
let compareView: CompareViewController;
let runsView: RunsViewController;
let healthView: HealthViewController;
let auditView: AuditViewController;
let lightbox: LightboxController;

let previewTimer: ReturnType<typeof setTimeout> | null = null;
let extEnabled: Record<string, boolean> = {};
let scanning = false;
let queuedNextMode: "image" | "video" | null = null;
let themeChoice: ThemeChoice = "auto";
let previewSeq = 0;
let imStatus: UpdateStatus | null = null;
let installing = false;

const baseName = (value: string): string => {
  const trimmed = value.replace(/[\\/]+$/, "");
  if (!trimmed) return value;
  return trimmed.split(/[\\/]/).pop() ?? trimmed;
};

const platformName = (platform: string): string => {
  if (platform === "win32") return "Windows";
  if (platform === "linux") return "Linux";
  if (platform === "darwin") return "macOS";
  return platform || "Desktop";
};

const formatError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// --------------------------------------------------------------------------
// Policy + config
// --------------------------------------------------------------------------

const videoPolicy = (): VideoPolicy => ({
  excludedFolders: [...state.excluded],
  includedFolders: [...state.included],
  excludedFiles: [...state.excludedFiles],
  includedFiles: [...state.includedFiles],
  extEnabled: Object.fromEntries(
    VIDEO_EXTS.map((ext) => [ext, extEnabled[ext] ?? true])
  ),
  minSizeBytes: Math.round(input("minsize").valueAsNumber * 1024 * 1024),
  copyUndersized: input("copyUndersized").checked,
  destMode: state.videoDestMode,
  outputFormat: state.currentFormat,
  container: input("videoContainer").value,
  quality: input("quality").valueAsNumber,
  speed: input("heicSpeed").valueAsNumber,
  maxResolution: Number(input("videoMaxRes").value) || 0,
  maxFps: Number(input("videoMaxFps").value) || 0,
  audioMode: input("videoAudioMode").value,
  tenBit: input("videoTenBit").checked,
  filmGrain: input("videoFilmGrain").valueAsNumber,
  skipAlreadyEfficient: input("videoSkipEfficient").checked,
  customParams: input("videoCustomParams").value.trim(),
});

const policy = (): Policy => ({
  excludedFolders: [...state.excluded],
  includedFolders: [...state.included],
  excludedFiles: [...state.excludedFiles],
  includedFiles: [...state.includedFiles],
  extEnabled: Object.fromEntries(
    CONVERT_EXTS.map((ext) => [ext, extEnabled[ext] ?? true])
  ),
  minSizeBytes: Math.round(input("minsize").valueAsNumber * 1024 * 1024),
  copyUndersized: input("copyUndersized").checked,
  includeRaw: input("includeRaw").checked,
  outputFormat: state.currentFormat,
  qualities: [input("quality").valueAsNumber],
  flattenGif: input("flattenGif").checked,
  heicSpeed: input("heicSpeed").valueAsNumber,
  maxResolution: Number(input("photoMaxRes").value) || 0,
  skipAlreadyEfficient: input("photoSkipLarger").checked,
  stripMetadata: input("photoStripMeta").checked,
});

const budgetBytes = (): number =>
  Math.max(1, Math.round(input("budget").valueAsNumber)) * 1024 ** 3;

const activePolicy = (): Policy | VideoPolicy =>
  state.mediaMode === "video" ? videoPolicy() : policy();

const save = async (): Promise<void> => {
  const currentDest = input("destination").value.trim();
  if (state.mediaMode === "video") {
    if (state.videoDestMode === "custom" && currentDest) {
      state.videoCustomDestination = currentDest;
    }
    await api<any>("video/config", {
      method: "POST",
      body: {
        customDestination:
          state.videoDestMode === "custom" ? state.videoCustomDestination : undefined,
        budgetBytes: budgetBytes(),
        policy: videoPolicy(),
      },
    });
    return;
  }
  const destination = currentDest;
  await api<ConfigResponse>("config", {
    method: "POST",
    body: {
      destination,
      budgetBytes: budgetBytes(),
      policy: policy(),
    },
  });
  if (state.status) state.status.destination = destination;
};

const schedulePreview = debounce((): void => {
  void refreshPreview();
}, 180);

const refreshPreview = async (): Promise<void> => {
  if (previewTimer) {
    clearTimeout(previewTimer);
    previewTimer = null;
  }
  if (!state.tree) return;

  const seq = ++previewSeq;
  state.previewSeq = seq;
  state.previewBusy = true;
  try {
    await save();
    const isCustomVideo = state.mediaMode === "video" && state.videoDestMode === "custom";
    const destVal = isCustomVideo
      ? (input("destination").value.trim() || state.videoCustomDestination)
      : undefined;
    const preview = await api<PreviewResponse>("preview", {
      method: "POST",
      body: {
        policy: activePolicy(),
        customDestination: destVal,
        destination: destVal,
      },
    });
    if (seq !== previewSeq) return;
    state.preview = preview;
    state.lastSync = null;
    state.previewBusy = false;
    plan.render();
    updateChrome();
  } catch (error) {
    if (seq !== previewSeq) return;
    state.previewBusy = false;
    plan.render();
    updateChrome();
    toast(formatError(error), "danger");
  }
};

const refreshStatus = async (): Promise<Status | null> => {
  try {
    const status = await api<Status>("status");
    applyStatusMeta(status);
    formatUi.refreshCards();
    return status;
  } catch (error) {
    toast(formatError(error), "danger");
    return null;
  }
};

// --------------------------------------------------------------------------
// Status + chrome
// --------------------------------------------------------------------------

const applyStatusMeta = (status: Status): void => {
  state.status = status;
  const destination = input("destination");
  if (document.activeElement !== destination) destination.value = status.destination;
  const source = input("sourceRoot");
  if (document.activeElement !== source) source.value = status.sourceRoot;

  const budget = clamp(Math.round(status.budgetBytes / 1024 ** 3), 1, 100);
  input("budget").value = String(budget);
  paintRange("budget");
  $("budgetOut").textContent = `${budget} GB`;

  const freeBytes = status.freeBytes;
  $("freeChip").textContent = freeBytes == null ? "" : `${fmt(freeBytes)} free`;
  $("freeChip").title = freeBytes == null
    ? "Free space on the destination volume is unavailable"
    : `Free space on the destination volume: ${status.freeLabel}`;
  $("freeLine").textContent = freeBytes == null
    ? "Free space on the destination volume is unavailable."
    : `Free on destination volume: ${status.freeLabel}`;

  $("statusPlatform").textContent = platformName(status.platform);
  $("statusMagick").textContent = status.magick ? shortVersion(status.magick.version) : "No ImageMagick";
  $("magickLine").textContent = status.magick
    ? `ImageMagick ${shortVersion(status.magick.version)}`
    : "ImageMagick not found";
  $("envChip").title = status.magick
    ? `${status.magick.path}${status.magick.libheif ? ` · libheif ${status.magick.libheif}` : ""}`
    : "ImageMagick is required to convert photos";

  const healthDot = $("healthDot");
  healthDot.className = "dot " + (status.magick?.avifWritable ? "ok" : status.magick ? "warn" : "bad");

  $("libraryName").textContent = status.sourceRoot ? baseName(status.sourceRoot) : "No library";
  $("libraryPill").title = status.sourceRoot || "Choose a source folder";
  $("stepSourceMeta").textContent = status.scanned
    ? `${status.fileCount.toLocaleString()} files`
    : "No folder";
  $("statusVersion").textContent = `v${APP_VERSION}`;
  $("versionLabel").textContent = `v${APP_VERSION}`;

  if (status.canPickFolder === false) {
    $("btnPickSource").classList.add("hidden");
    $("btnPick").classList.add("hidden");
    input("sourceRoot").placeholder = "Type the folder path";
    input("destination").placeholder = "Type the output path";
  }
};

const selectedSummary = (): { files: ScannedFile[]; bytes: number } => {
  const files = library.selected();
  return { files, bytes: files.reduce((sum, file) => sum + file.size, 0) };
};

const updateRail = (): void => {
  const selected = selectedSummary();
  const isVideo = state.mediaMode === "video";
  const scanTotals = state.lastScan?.totals;
  const total = isVideo
    ? (scanTotals?.videoCount ?? 0)
    : ((scanTotals?.imageCount ?? 0) + (scanTotals?.rawCount ?? 0));
  const p = state.preview;
  const spec = state.formatSpecs[state.currentFormat];

  $("stepSourceMeta").textContent = state.tree
    ? `${total.toLocaleString()} ${isVideo ? "videos" : "photos"}`
    : scanning
      ? "Scanning…"
      : "No folder";
  $("stepSelectMeta").textContent = state.tree
    ? `${selected.files.length.toLocaleString()} of ${total.toLocaleString()}`
    : "None";
  $("stepOutputMeta").textContent = spec
    ? `${spec.shortLabel} ${$("qualityOut").textContent}`
    : "—";
  $("stepReviewMeta").textContent = p
    ? p.budget.fits ? fmt(p.estOutputBytes) : "Over budget"
    : state.tree ? "Waiting" : "Waiting";

  const runPct = state.run.total > 0 ? Math.round((state.run.done / state.run.total) * 100) : 0;
  $("stepRunMeta").textContent = state.running
    ? state.run.state === "paused" ? "Paused" : `Running ${runPct}%`
    : state.run.state === "done" ? "Done"
      : state.run.state === "failed" ? "Failed"
        : state.run.state === "cancelled" ? "Cancelled"
          : "Ready";

  const states: Record<string, "current" | "done" | "pending"> = {
    source: state.tree ? "done" : "current",
    select: state.tree ? (selected.files.length ? "done" : "current") : "pending",
    output: state.tree && selected.files.length && spec ? "done" : selected.files.length ? "current" : "pending",
    review: state.running ? "done" : p ? "current" : selected.files.length ? "current" : "pending",
    run: state.running ? "current" : ["done", "failed", "cancelled"].includes(state.run.state) ? "done" : "pending",
  };
  const numbers: Record<string, string> = { source: "1", select: "2", output: "3", review: "4", run: "5" };
  for (const [step, value] of Object.entries(states)) {
    const button = document.getElementById(`step${step.charAt(0).toUpperCase()}${step.slice(1)}`);
    if (!button) continue;
    button.dataset.state = value;
    const iconNode = button.querySelector<HTMLElement>(".rail-icon");
    if (iconNode) {
      iconNode.innerHTML = value === "done" ? icon("check", 12) : numbers[step];
    }
  }
};

const updateChrome = (): void => {
  const selected = selectedSummary();
  const total = state.lastScan?.totals.count ?? 0;
  if (state.tree) {
    $("statusSelection").textContent =
      `${selected.files.length.toLocaleString()} of ${total.toLocaleString()} selected · ${fmt(selected.bytes)}`;
  } else {
    $("statusSelection").textContent = "No scan";
  }
  $("statusScan").textContent = scanning
    ? "Scanning…"
    : state.running
      ? state.run.state === "paused" ? "Paused" : `Running · ${state.run.done.toLocaleString()} of ${state.run.total.toLocaleString()}`
      : state.lastScan
        ? `Scanned ${state.lastScan.durationMs} ms · ${total.toLocaleString()} files`
        : "Ready";
  $("statusMagick").textContent = state.status?.magick ? shortVersion(state.status.magick.version) : "No ImageMagick";
  $("sourceInfo").textContent = state.lastScan
    ? `${state.lastScan.durationMs} ms · ${state.lastScan.totals.count.toLocaleString()} files`
    : "";
  $("libraryName").textContent = input("sourceRoot").value.trim()
    ? baseName(input("sourceRoot").value.trim())
    : "No library";
  const free = state.preview?.freeBytes ?? state.status?.freeBytes ?? null;
  $("freeChip").textContent = free == null ? "" : `${fmt(free)} free`;
  $("recipeMeta").textContent = state.formatSpecs[state.currentFormat]?.shortLabel ?? "—";
  paintRange("viewJobs");
  paintRange("viewCpuLimit");
  updateRail();
  updateStartOptions();
};

const updateStartOptions = (): void => {
  const onlyNew = input("onlyNew").checked;
  const hint = document.getElementById("startHint");
  if (hint && state.preview && !state.running && onlyNew && state.preview.convert + state.preview.copy > 0) {
    hint.textContent = "Skip already converted files is on — the run will check the destination first.";
  }
};

// --------------------------------------------------------------------------
// Source + destination
// --------------------------------------------------------------------------

const showSourceError = (message: string, kind: "bad" | "warn" = "bad"): void => {
  const node = $("sourceError");
  node.className = `inline-msg ${kind}`;
  node.textContent = message;
};

const clearSourceError = (): void => {
  const node = $("sourceError");
  node.className = "inline-msg hidden";
  node.textContent = "";
};

const showDestError = (message: string): void => {
  const node = $("destError");
  node.className = "inline-msg bad";
  node.textContent = message;
};

const clearDestError = (): void => {
  const node = $("destError");
  node.className = "inline-msg hidden";
  node.textContent = "";
};

const applySource = async (): Promise<void> => {
  const source = input("sourceRoot").value.trim();
  const previousSource = state.status?.sourceRoot ?? "";
  if (!source) {
    showSourceError("Enter a folder path.");
    input("sourceRoot").focus();
    return;
  }

  scanning = true;
  clearSourceError();
  $<HTMLButtonElement>("btnScan").disabled = true;
  $("btnScan").textContent = "Scanning…";
  $("sourceInfo").textContent = "Validating…";
  updateChrome();

  try {
    const check = await api<ValidateResponse>("validate", {
      method: "POST",
      body: { sourceRoot: source, destination: input("destination").value.trim() },
    });
    if (!check.ok) {
      throw new Error(check.error || "That folder is not readable.");
    }
    if (!check.isDirectory) throw new Error("That path is a file, not a folder.");

    await api<ConfigResponse>("config", {
      method: "POST",
      body: {
        sourceRoot: source,
        destination: input("destination").value.trim(),
        budgetBytes: budgetBytes(),
        policy: policy(),
      },
    });
    if (state.status) {
      state.status.sourceRoot = source;
      state.status.scanned = false;
    }

    const scan = await api<ScanResult>("scan", {
      method: "POST",
      body: { sourceRoot: source },
    });
    state.status && (state.status.scanned = true);
    library.setScan(scan, true);
    state.lastEstimate = null;
    state.lastSync = null;
    state.preview = null;
    updateChrome();
    await refreshPreview();
    toast(`Scanned ${scan.totals.count.toLocaleString()} files in ${(scan.durationMs / 1000).toFixed(1)}s.`, "success");
    if (scan.riskyNames.length) {
      showSourceError(
        `${scan.riskyNames.length} folder name(s) can break copied paths: ${scan.riskyNames.slice(0, 2).map((entry) => entry.rel).join(", ")}. Using a non-standard slash character.`,
        "warn",
      );
    }
  } catch (error) {
    showSourceError(formatError(error));
    if (!state.tree) {
      $("scanSummary").textContent = "not scanned";
    } else if (previousSource) {
      // The scan still describes the old source; keep the field honest.
      input("sourceRoot").value = previousSource;
    }
  } finally {
    scanning = false;
    $<HTMLButtonElement>("btnScan").disabled = false;
    $("btnScan").textContent = "Scan";
    updateChrome();
  }
};

const applyDestination = async (previous: string): Promise<void> => {
  const destination = input("destination").value.trim();
  if (!destination) {
    showDestError("Choose an output folder.");
    input("destination").value = previous;
    return;
  }
  clearDestError();
  try {
    if (state.mediaMode === "video") {
      state.videoDestMode = "custom";
      state.videoCustomDestination = destination;
      syncVideoDestUi();
    }
    await save();
    await refreshPreview();
  } catch (error) {
    input("destination").value = previous;
    if (state.mediaMode === "video") {
      state.videoCustomDestination = previous;
      syncVideoDestUi();
    }
    showDestError(formatError(error));
    toast(formatError(error), "danger");
  }
};

const pickFolder = async (kind: "source" | "destination"): Promise<void> => {
  try {
    const result = await api<PickResponse>("pick", {
      method: "POST",
      body: { title: kind === "source" ? "Choose the source photo folder" : "Choose the output folder" },
    });
    if (!result.path) return;
    if (kind === "source") {
      input("sourceRoot").value = result.path;
      await applySource();
    } else {
      const previous = input("destination").value;
      input("destination").value = result.path;
      if (state.mediaMode === "video") {
        state.videoDestMode = "custom";
        state.videoCustomDestination = result.path;
        syncVideoDestUi();
      }
      await applyDestination(previous);
    }
  } catch (error) {
    toast(formatError(error), "danger");
  }
};

// --------------------------------------------------------------------------
// Format selection
// --------------------------------------------------------------------------

const chooseFormat = async (id: OutputFormat): Promise<void> => {
  if (state.running || state.starting) return;
  if (id === state.currentFormat) return;
  const oldId = state.currentFormat;
  const oldSpec = state.formatSpecs[oldId];
  const newSpec = state.formatSpecs[id];
  if (!oldSpec || !newSpec) return;

  const oldMemory = state.formatMemory[oldId] ?? {
    quality: input("quality").valueAsNumber,
    speed: input("heicSpeed").valueAsNumber,
  };
  state.formatMemory[oldId] = {
    quality: input("quality").valueAsNumber,
    speed: input("heicSpeed").valueAsNumber,
  };

  const oldDestination = input("destination").value;
  let nextDestination = oldDestination;
  if (state.mediaMode !== "video") {
    nextDestination = nextDestinationOnFormatChange(
      oldDestination,
      input("sourceRoot").value,
      oldSpec.destinationSuffix,
      newSpec.destinationSuffix,
      state.status?.caseInsensitive ?? true,
    );
  }

  formatUi.apply(id, true);
  if (nextDestination !== oldDestination) {
    input("destination").value = nextDestination;
    toast(`Destination updated to ${nextDestination}.`, "info");
  }

  if (state.mediaMode === "video") {
    syncVideoDestUi();
  }

  try {
    await save();
    await refreshPreview();
  } catch (error) {
    state.formatMemory[oldId] = oldMemory;
    input("destination").value = oldDestination;
    formatUi.apply(oldId, true);
    toast(formatError(error), "danger");
  }
};

// --------------------------------------------------------------------------
// Video Mode & Destination Helpers
// --------------------------------------------------------------------------

const syncVideoDestUi = (): void => {
  if (state.mediaMode !== "video") return;
  const destMode = state.videoDestMode;
  $("btnDestMerge").setAttribute("aria-pressed", String(destMode === "merge"));
  $("btnDestSubfolder").setAttribute("aria-pressed", String(destMode === "subfolder"));
  $("btnDestCustom").setAttribute("aria-pressed", String(destMode === "custom"));

  const photoDest = state.status?.destination ?? input("destination").value.trim();
  const sep = state.status?.pathSeparator ?? "\\";
  const destInput = input("destination");
  const pickBtn = $<HTMLButtonElement>("btnPick");

  if (destMode === "merge") {
    destInput.value = photoDest;
    destInput.readOnly = true;
    pickBtn.disabled = true;
    $("videoDestResolved").textContent = `Merging into photo tree: ${photoDest}${sep}<subfolder>${sep}<video>`;
  } else if (destMode === "subfolder") {
    const sub = `${photoDest.replace(/[\\/]+$/, "")}${sep}video`;
    destInput.value = sub;
    destInput.readOnly = true;
    pickBtn.disabled = true;
    $("videoDestResolved").textContent = `Writing inside subfolder: ${sub}${sep}<subfolder>${sep}<video>`;
  } else {
    destInput.readOnly = false;
    pickBtn.disabled = false;
    if (!state.videoCustomDestination && destInput.value.trim()) {
      state.videoCustomDestination = destInput.value.trim();
    }
    destInput.value =
      state.videoCustomDestination ||
      `${input("sourceRoot").value.replace(/[\\/]+$/, "")}-${state.currentFormat}`;
    state.videoCustomDestination = destInput.value;
    $("videoDestResolved").textContent = `Writing to separate custom location: ${destInput.value}`;
  }
};

const switchMediaMode = async (next: "image" | "video"): Promise<void> => {
  if (state.running || state.starting || state.mediaMode === next) return;  state.mediaMode = next;
  const isVideo = next === "video";

  $("app").setAttribute("data-media-mode", next);
  $("btnModeImage").setAttribute("aria-pressed", String(!isVideo));
  $("btnModeVideo").setAttribute("aria-pressed", String(isVideo));

  $("videoPresetsWrap").classList.toggle("hidden", !isVideo);
  $("imageIncludeOpts").classList.toggle("hidden", isVideo);
  $("videoTinkerOpts").classList.toggle("hidden", !isVideo);
  $("videoDestModes").classList.toggle("hidden", !isVideo);

  if (isVideo) {
    input("jobs").value = "1";
    updateJobsReadout();
    const vStatus = await api<any>("video/status");
    state.videoStatus = vStatus;
    state.videoDestMode = vStatus.policy.destMode ?? "merge";
    state.videoCustomDestination = vStatus.customDestination ?? "";
    extEnabled = { ...vStatus.policy.extEnabled };
    formatUi.init({
      ...(state.status as Status),
      formats: vStatus.formats,
      outputFormat: vStatus.outputFormat,
      policy: {
        ...(state.status?.policy as Policy),
        outputFormat: vStatus.outputFormat,
        qualities: [vStatus.policy.quality],
        heicSpeed: vStatus.policy.speed,
      },
    });
    $("ffUpdate").classList.toggle("hidden", Boolean(vStatus.ffmpeg));
    syncVideoDestUi();
  } else {
    input("destination").readOnly = false;
    $<HTMLButtonElement>("btnPick").disabled = false;
    if (state.status) {
      input("destination").value = state.status.destination;
      extEnabled = { ...state.status.policy.extEnabled };
      formatUi.init(state.status);
    }
    $("ffUpdate").classList.add("hidden");
  }

  renderExtToggles();
  library.refresh();
  await refreshPreview();
};

/**
 * Queue the opposite media mode to start automatically when the current run
 * finishes, so a mixed photo/video library can be converted unattended.
 */
const startBothModes = async (): Promise<void> => {
  queuedNextMode = state.mediaMode === "image" ? "video" : "image";
  await runLifecycle.start();
};

const applyVideoPreset = async (preset: "archival" | "balanced" | "spacesaver"): Promise<void> => {
  $("btnPresetArchival").setAttribute("aria-pressed", String(preset === "archival"));
  $("btnPresetBalanced").setAttribute("aria-pressed", String(preset === "balanced"));
  $("btnPresetSpaceSaver").setAttribute("aria-pressed", String(preset === "spacesaver"));

  if (preset === "archival") {
    input("quality").value = "72";
    input("heicSpeed").value = "5";
    input("videoMaxRes").value = "0";
    input("videoMaxFps").value = "0";
    input("videoAudioMode").value = "copy";
  } else if (preset === "balanced") {
    input("quality").value = "60";
    input("heicSpeed").value = "6";
    input("videoMaxRes").value = "0";
    input("videoMaxFps").value = "0";
    input("videoAudioMode").value = "auto";
  } else {
    input("quality").value = "44";
    input("heicSpeed").value = "7";
    input("videoMaxRes").value = "1080";
    input("videoMaxFps").value = "30";
    input("videoAudioMode").value = "opus64";
  }
  paintRange("quality");
  paintRange("heicSpeed");
  const spec = state.formatSpecs[state.currentFormat];
  if (spec) {
    $("qualityOut").textContent = formatUi.qualityText(spec, input("quality").valueAsNumber);
    $("heicSpeedOut").textContent = String(input("heicSpeed").valueAsNumber);
  }
  await save();
  await refreshPreview();
};

const setVideoDestMode = async (mode: "merge" | "subfolder" | "custom"): Promise<void> => {
  state.videoDestMode = mode;
  syncVideoDestUi();
  await save();
  await refreshPreview();
};

const installFfmpeg = async (): Promise<void> => {
  try {
    toast("Installing FFmpeg in the background…", "info");
    $("ffUpdate").textContent = "Installing FFmpeg…";
    await api("video/ffmpeg/install", { method: "POST", body: {} });
    toast("FFmpeg installed successfully!", "success");
    $("ffUpdate").classList.add("hidden");
    const vStatus = await api<any>("video/status");
    state.videoStatus = vStatus;
    formatUi.refreshCards();
  } catch (err) {
    toast(formatError(err), "danger");
    $("ffUpdate").textContent = "Install FFmpeg";
  }
};

// --------------------------------------------------------------------------
// Extension toggles + simple controls
// --------------------------------------------------------------------------

const renderExtToggles = (): void => {
  const host = $("extToggles");
  host.innerHTML = "";
  const allowed = state.mediaMode === "video" ? VIDEO_EXTS : CONVERT_EXTS;
  for (const ext of allowed) {
    const enabled = extEnabled[ext] ?? true;
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "ext-chip" + (enabled ? " on" : "");
    chip.textContent = `.${ext}`;
    chip.title = `${enabled ? "Include" : "Skip"} .${ext} files`;
    chip.addEventListener("click", () => {
      extEnabled[ext] = !enabled;
      chip.classList.toggle("on", extEnabled[ext]);
      chip.title = `${extEnabled[ext] ? "Include" : "Skip"} .${ext} files`;
      schedulePreview();
    });
    host.append(chip);
  }
};

const setUndersize = (copy: boolean): void => {
  input("copyUndersized").checked = copy;
  $("copyUnder").setAttribute("aria-pressed", String(copy));
  $("skipUnder").setAttribute("aria-pressed", String(!copy));
  $("minsizeNote").textContent = copy
    ? "Files under the floor are copied byte-for-byte, so no pixels are lost."
    : "Files under the floor are skipped. Nothing is written for them.";
  schedulePreview();
};

const updateMinSizeReadout = (): void => {
  $("minsizeOut").textContent = `${input("minsize").valueAsNumber.toFixed(2)} MB`;
};

const updateJobsReadout = (): void => {
  $("jobsOut").textContent = input("jobs").value;
  paintRange("jobs");
};

const updateCpuLimitReadout = (): void => {
  $("cpuLimitOut").textContent = `${input("cpuLimit").value}%`;
  paintRange("cpuLimit");
};

const updateFilmGrainReadout = (): void => {
  const val = input("videoFilmGrain").valueAsNumber;
  $("videoFilmGrainOut").textContent = val === 0 ? "Off (0)" : `Level ${val}`;
  paintRange("videoFilmGrain");
};

const paintRange = (id: string): void => {
  const node = input(id);
  const min = Number(node.min) || 0;
  const max = Number(node.max) || 100;
  const value = node.valueAsNumber;
  const percent = max > min ? ((value - min) / (max - min)) * 100 : 0;
  node.style.setProperty("--fill", `${clamp(percent, 0, 100).toFixed(2)}%`);
};

const paintRanges = (): void => {
  for (const id of ["minsize", "jobs", "cpuLimit", "budget", "viewJobs", "viewCpuLimit", "videoFilmGrain"]) paintRange(id);
};

// --------------------------------------------------------------------------
// Estimate
// --------------------------------------------------------------------------

const runEstimate = async (): Promise<void> => {
  if (!state.tree) {
    toast("Scan a library first.", "warning");
    return;
  }
  const box = $("estimateBox");
  box.classList.remove("hidden");
  const isVideo = state.mediaMode === "video";
  box.innerHTML = `<h4>Estimate <small>sampling real files</small></h4>
    <p class="empty-note">${
      isVideo
        ? "Encoding 3-second midpoint slices from up to 5 videos at the current recipe…"
        : "Encoding up to 120 images at the current recipe…"
    }</p>`;
  try {
    const estimate = await api<Estimate>("estimate", {
      method: "POST",
      body: {
        sampleSize: isVideo ? 5 : 120,
        jobs: clamp(input("jobs").valueAsNumber, 1, 16),
        policy: activePolicy(),
      },
    });
    state.lastEstimate = estimate;
    const ratio = estimate.ratio > 0 ? `${(1 / estimate.ratio).toFixed(1)}:1` : "—";
    box.innerHTML = `<h4>Estimate <small>${estimate.sampleSize.toLocaleString()} files sampled · ${escapeHtml(state.formatSpecs[estimate.format]?.shortLabel ?? estimate.format)}</small></h4>
      <dl class="kv">
        <dt>Measured ratio</dt><dd class="mono">${ratio}</dd>
        <dt>Mean output</dt><dd class="mono">${fmt(estimate.meanOutputBytes)}</dd>
        <dt>Projected output</dt><dd class="mono">${fmt(estimate.projectedOutputBytes)}</dd>
        <dt>Projected time</dt><dd class="mono">${dur(estimate.projectedSeconds)}</dd>
        <dt>Method</dt><dd>${estimate.method === "sampled" ? "Sampled encode" : "Flat ratio"} · ${dur(estimate.durationMs / 1000)}</dd>
      </dl>`;
    plan.render();
    await refreshPreview();
  } catch (error) {
    box.innerHTML = `<h4>Estimate</h4><p class="inline-msg">${escapeHtml(formatError(error))}</p>`;
  }
};

// --------------------------------------------------------------------------
// Undo + compare + verify
// --------------------------------------------------------------------------

const undoManifest = async (id: string, summary?: ManifestSummary): Promise<void> => {
  const detail = summary
    ? `${summary.converted.toLocaleString()} converted and ${summary.copied.toLocaleString()} copied files (${fmt(summary.bytes)}) are recorded in this manifest.`
    : `Every output recorded in manifest ${id} is a candidate.`;
  const ok = await ask({
    title: "Undo this run?",
    body: `<p class="modal-copy">${escapeHtml(detail)}</p>
      <p class="modal-copy">Only files recorded in the manifest are removed. Files outside the destination, or files changed since the run, are refused for safety. The source library is never touched.</p>`,
    confirmLabel: "Remove run outputs",
    danger: true,
  });
  if (!ok) return;
  try {
    const result = await api<UndoResult>("undo", { method: "POST", body: { id } });
    const refused = result.refused ? ` · ${result.refused.toLocaleString()} refused for safety` : "";
    const errors = result.errors.length ? ` · ${result.errors.length.toLocaleString()} errors` : "";
    toast(`Removed ${result.removed.toLocaleString()} files, freed ${fmt(result.bytesFreed)}${refused}${errors}.`, "success");
    if (state.lastManifestId === id) {
      state.lastManifestId = null;
      state.lastSummary = null;
      runView.renderDock();
      if (state.view === "run") runView.renderView();
    }
    await refreshPreview();
    await refreshStatus();
  } catch (error) {
    toast(formatError(error), "danger");
  }
};

const verifyJob = async (jobId: string): Promise<VerifyResponse> =>
  api<VerifyResponse>("verify", { method: "POST", body: { jobId } });

const runCompare = async (
  rel: string,
  format?: OutputFormat,
  timestampSec?: number,
): Promise<CompareResponse> => {
  const chosenFormat = format ?? state.currentFormat;
  const spec = state.formatSpecs[chosenFormat];
  return api<CompareResponse>("compare", {
    method: "POST",
    body: {
      rel,
      format: chosenFormat,
      qualities: spec?.compareQualities ?? [30, 50, 60, 70, 80],
      timestampSec,
    },
  });
};

// --------------------------------------------------------------------------
// Modal + confirm
// --------------------------------------------------------------------------

let confirmResolve: ((ok: boolean) => void) | null = null;

const setModalFoot = (html: string): void => {
  const foot = $("modalFoot");
  if (!html) {
    foot.classList.add("hidden");
    foot.innerHTML = "";
    return;
  }
  foot.innerHTML = html;
  foot.classList.remove("hidden");
};

const plainModal = (title: string, html: string, size: "sm" | "md" | "lg" = "md"): void => {
  setModalFoot("");
  openModal(title, html, size);
};

const settleConfirm = (ok: boolean): void => {
  const resolve = confirmResolve;
  confirmResolve = null;
  closeModal();
  setModalFoot("");
  resolve?.(ok);
};

const ask = (opts: ConfirmOptions): Promise<boolean> => {
  if (confirmResolve) settleConfirm(false);
  openModal(opts.title, opts.body, "sm");
  setModalFoot(
    `<button id="modalCancel" class="btn ghost" type="button">${escapeHtml(opts.cancelLabel ?? "Cancel")}</button>` +
    `<button id="modalConfirm" class="btn ${opts.danger ? "danger" : "primary"}" type="button">${escapeHtml(opts.confirmLabel)}</button>`,
  );
  $("modalCancel").addEventListener("click", () => settleConfirm(false));
  $("modalConfirm").addEventListener("click", () => settleConfirm(true));
  return new Promise((resolve) => {
    confirmResolve = resolve;
  });
};

// --------------------------------------------------------------------------
// View switching
// --------------------------------------------------------------------------

type ViewName = "workspace" | "run" | "compare" | "runs" | "health";

const switchView = (view: ViewName): void => {
  state.view = view;
  $("workspace").classList.toggle("hidden", view !== "workspace");
  $("viewRun").classList.toggle("hidden", view !== "run");
  $("viewCompare").classList.toggle("hidden", view !== "compare");
  $("viewRuns").classList.toggle("hidden", view !== "runs");
  $("viewHealth").classList.toggle("hidden", view !== "health");
  if (view === "run") runView.renderView();
};

// --------------------------------------------------------------------------
// Actions passed to views
// --------------------------------------------------------------------------

const actions: ViewActions = {
  switchView,
  refreshPreview,
  refreshTree: () => {
    library.refresh();
    updateChrome();
  },
  policy: activePolicy,
  toast,
  confirm: ask,
  startRun: (opts) => runLifecycle.start(opts),
  undoManifest,
  verifyJob,
  runCompare,
  selectedFiles: () => library.selected(),
  setQuality: (quality, format) => formatUi.setQuality(quality, format),
  checkMagick: (force) => checkMagick(force),
  refreshStatusMagick: async () => {
    await refreshStatus();
  },
  installMagick: () => installMagick(),
};

// --------------------------------------------------------------------------
// ImageMagick update + install
// --------------------------------------------------------------------------

const imKind = (im: UpdateStatus): string =>
  im.assetKind === "appimage" ? "AppImage" : "portable build";

const renderImPill = (im: UpdateStatus): void => {
  const pill = $("imUpdate");
  if (im.updateAvailable && im.latest) {
    pill.classList.remove("hidden");
    pill.classList.toggle("warn", Boolean(im.installed));
    pill.textContent = im.installed
      ? `ImageMagick ${im.latest.version} available`
      : `Download ImageMagick ${im.latest.version}`;
    pill.title = im.installed
      ? `Installed ${shortVersion(im.installed.version)} — click to update`
      : `ImageMagick was not found — click to download the ${imKind(im)}`;
  } else if (!im.installed) {
    pill.classList.remove("hidden");
    pill.classList.add("warn");
    pill.textContent = "ImageMagick not found";
    pill.title = im.supported === false
      ? "Install ImageMagick 7 with AVIF support from your distribution"
      : `Click to download the ${imKind(im)}`;
  } else {
    pill.classList.add("hidden");
  }
};

const checkMagick = async (force = false): Promise<UpdateStatus> => {
  const im = await api<UpdateStatus>(`imagemagick/check${force ? "?force=1" : ""}`);
  imStatus = im;
  state.imStatus = im;
  renderImPill(im);
  return im;
};

const startInstall = async (im: UpdateStatus): Promise<void> => {
  if (installing) return;
  installing = true;
  plainModal(
    "Installing ImageMagick",
    `<p class="modal-copy">Downloading and verifying ImageMagick ${escapeHtml(im.latest?.version ?? "")}…</p>
     <div class="meter" style="margin-top:14px"><div id="imInstallFill"></div></div>
     <p id="imInstallNote" class="note" aria-live="polite">Starting the download…</p>`,
    "sm",
  );

  const timer = window.setInterval(() => {
    void (async () => {
      try {
        const p = await api<InstallProgress>("imagemagick/progress");
        const note = document.getElementById("imInstallNote");
        const fill = document.getElementById("imInstallFill");
        if (note && p.message) note.textContent = p.message;
        if (fill) setWidth(fill, Math.max(0, Math.min(100, p.percent)) / 100);
      } catch {
        /* the install POST reports the real error */
      }
    })();
  }, 700);

  try {
    const result = await api<InstallResponse>("imagemagick/install", {
      method: "POST",
      body: {},
    });
    try {
      localStorage.removeItem("imUpdateDismissed");
    } catch {
      /* private mode */
    }
    toast(`ImageMagick ${result.version} installed. Reloading…`, "success");
    window.setTimeout(() => window.location.reload(), 1200);
  } catch (error) {
    const note = document.getElementById("imInstallNote");
    const fill = document.getElementById("imInstallFill");
    if (note) {
      note.className = "inline-msg bad";
      note.textContent = formatError(error);
    }
    if (fill) fill.classList.add("over");
    toast(formatError(error), "danger");
    installing = false;
  } finally {
    window.clearInterval(timer);
  }
};

const openMagickModal = (im: UpdateStatus): void => {
  const installed = im.installed
    ? `Installed <b>${escapeHtml(shortVersion(im.installed.version))}</b>${im.installed.avifWritable ? "" : " · AVIF unavailable"}`
    : `<span class="bad">ImageMagick was not found on this device.</span>`;
  const latest = im.latest
    ? `Latest on GitHub <b>${escapeHtml(im.latest.version)}</b>`
    : im.online
      ? "Latest version: unknown"
      : "Could not reach github.com.";
  const rows: string[] = [];
  if (im.latest) {
    rows.push(`<div class="fact-row"><span>${imKind(im)}</span><span class="mono">${escapeHtml(im.latest.asset.name)}</span></div>`);
    rows.push(`<div class="fact-row"><span>Download size</span><span>${fmt(im.latest.asset.size)}</span></div>`);
    rows.push(`<div class="fact-row"><span>Install into</span><span class="mono" title="${escapeHtml(im.installDir)}">${escapeHtml(im.installDir)}</span></div>`);
  }
  const notes: string[] = [];
  if (!im.supported) {
    notes.push("Automatic downloads are not available on this build. Install ImageMagick 7 with AVIF support using your package manager.");
  } else if (!im.online) {
    notes.push(`Could not reach github.com${im.error ? `: ${im.error}` : ""}. You can download the ${imKind(im)} manually and place it in the folder above.`);
  } else if (im.installed && !im.updateAvailable) {
    notes.push("ImageMagick is up to date.");
  }

  plainModal(
    im.installed ? "ImageMagick" : "ImageMagick is not installed",
    `<p class="modal-copy">${installed} &nbsp;·&nbsp; ${latest}</p>
     ${rows.length ? `<div class="fact-list" style="margin-top:12px">${rows.join("")}</div>` : ""}
     ${notes.map((note) => `<p class="note">${escapeHtml(note)}</p>`).join("")}
     <p class="note">A managed build lives inside this app's data folder. Originals are never touched.</p>`,
    "sm",
  );

  const canInstall = im.supported && im.latest && (im.updateAvailable || !im.installed);
  setModalFoot(
    `<button id="imLater" class="btn ghost" type="button">${im.updateAvailable ? "Not now" : "Close"}</button>` +
    `<button id="imRecheck" class="btn ghost" type="button">Check again</button>` +
    (canInstall ? `<button id="imInstall" class="btn primary" type="button">${im.installed ? "Download update" : "Install ImageMagick"}</button>` : ""),
  );

  $("imLater").addEventListener("click", () => {
    if (im.installed && im.updateAvailable && im.latest) {
      try {
        localStorage.setItem("imUpdateDismissed", im.latest.version);
      } catch {
        /* private mode */
      }
    }
    closeModal();
    setModalFoot("");
  });

  $("imRecheck").addEventListener("click", () => {
    const button = $<HTMLButtonElement>("imRecheck");
    button.disabled = true;
    button.textContent = "Checking…";
    void (async () => {
      try {
        const next = await checkMagick(true);
        openMagickModal(next);
      } catch (error) {
        button.disabled = false;
        button.textContent = "Check again";
        toast(formatError(error), "danger");
      }
    })();
  });

  document.getElementById("imInstall")?.addEventListener("click", () => {
    void startInstall(im);
  });
};

const installMagick = async (): Promise<void> => {
  if (installing) return;
  try {
    const im = imStatus ?? await checkMagick(false);
    openMagickModal(im);
  } catch (error) {
    toast(formatError(error), "danger");
  }
};

// --------------------------------------------------------------------------
// Compakta self-update
// --------------------------------------------------------------------------

let appUpdateTimer: number | null = null;

const renderAppPill = (status: AppUpdateStatus): void => {
  const pill = $("appUpdate");
  if (status.stage === "ready") {
    pill.classList.remove("hidden", "warn");
    pill.classList.add("ready");
    pill.textContent = `Update Ready (v${status.latestVersion}) — Click to Apply`;
    pill.title = `Compakta v${status.latestVersion} is downloaded and ready. Click to restart and apply.`;
  } else if (status.stage === "downloading") {
    pill.classList.remove("hidden", "ready");
    pill.classList.add("warn");
    pill.textContent = `Downloading App v${status.latestVersion} (${status.percent}%)`;
    pill.title = `Downloading update: ${status.percent}%`;
  } else if (status.updateAvailable && status.latestVersion) {
    pill.classList.remove("hidden", "ready");
    pill.classList.add("warn");
    pill.textContent = `Compakta v${status.latestVersion} available`;
    pill.title = `New version v${status.latestVersion} available — click to review`;
  } else {
    pill.classList.add("hidden");
  }
};

const pollAppDownloadProgress = (): void => {
  if (appUpdateTimer !== null) return;
  appUpdateTimer = window.setInterval(() => {
    void (async () => {
      try {
        const p = await api<AppUpdateStatus>("app/update/progress");
        state.appUpdate = p;
        renderAppPill(p);

        const fill = document.getElementById("appDownloadFill");
        const note = document.getElementById("appDownloadNote");
        if (fill) setWidth(fill, Math.max(0, Math.min(100, p.percent)) / 100);
        if (note && p.message) note.textContent = p.message;

        if (p.stage === "ready") {
          if (appUpdateTimer !== null) {
            window.clearInterval(appUpdateTimer);
            appUpdateTimer = null;
          }
          toast(`Compakta v${p.latestVersion} is ready to install!`, "success");
          if (document.getElementById("appDownloadFill")) {
            openAppUpdateModal(p);
          }
        } else if (p.stage === "error") {
          if (appUpdateTimer !== null) {
            window.clearInterval(appUpdateTimer);
            appUpdateTimer = null;
          }
          toast(p.message || "Update download failed.", "danger");
        }
      } catch {
        /* ignore polling errors */
      }
    })();
  }, 750);
};

const openAppUpdateModal = (status: AppUpdateStatus): void => {
  if (status.stage === "ready") {
    const isJobActive = state.running || state.run.state === "running" || state.run.state === "paused";
    plainModal(
      "Update Ready to Install",
      `<p class="modal-copy">Compakta <strong>v${escapeHtml(status.latestVersion ?? "")}</strong> is downloaded and ready to install.</p>
       <div class="fact-list">
         <div class="fact-row"><span>New version</span><span class="mono">v${escapeHtml(status.latestVersion ?? "")}</span></div>
         <div class="fact-row"><span>Current version</span><span class="mono">v${escapeHtml(status.currentVersion)}</span></div>
         <div class="fact-row"><span>Package</span><span>Lean update (${escapeHtml(status.assetName ?? "package")})</span></div>
       </div>
       <p class="note">Applying the update will launch the installer and restart the app. Any bundled ImageMagick is preserved automatically.</p>
       ${isJobActive ? `<div class="inline-msg warn" style="margin-top:10px">A conversion job is in progress. Wait for it to complete or pause/cancel it before updating.</div>` : ""}`,
      "sm",
    );

    setModalFoot(
      `<button id="btnAppReadyLater" class="btn ghost" type="button">Later</button>` +
      `<button id="btnAppApply" class="btn primary" type="button" ${isJobActive ? 'disabled="disabled"' : ""}>Restart & Apply Update</button>`,
    );

    $("btnAppReadyLater").addEventListener("click", () => {
      closeModal();
      setModalFoot("");
    });

    $("btnAppApply").addEventListener("click", () => {
      void (async () => {
        try {
          const btn = $<HTMLButtonElement>("btnAppApply");
          btn.disabled = true;
          btn.textContent = "Restarting…";
          plainModal(
            "Applying Update",
            `<p class="modal-copy ok">Launching the installer and restarting Compakta…</p>
             <p class="note">This window will close as the installer updates your application.</p>`,
            "sm",
          );
          setModalFoot("");
          await api("app/update/apply", { method: "POST", body: {} });
        } catch (err) {
          toast(formatError(err), "danger");
          closeModal();
        }
      })();
    });
    return;
  }

  if (status.stage === "downloading") {
    plainModal(
      `Downloading Compakta v${escapeHtml(status.latestVersion ?? "")}`,
      `<p class="modal-copy">Downloading the update in the background…</p>
       <div class="meter" style="margin-top:14px"><div id="appDownloadFill"></div></div>
       <p id="appDownloadNote" class="note" aria-live="polite">${escapeHtml(status.message)}</p>
       <p class="note" style="margin-top:10px">You can close this dialog at any time. The download will continue in the background while you work.</p>`,
      "sm",
    );
    const fill = document.getElementById("appDownloadFill");
    if (fill) setWidth(fill, Math.max(0, Math.min(100, status.percent)) / 100);

    setModalFoot(
      `<button id="btnAppDownloadDismiss" class="btn ghost" type="button">Hide (keep downloading)</button>`,
    );
    $("btnAppDownloadDismiss").addEventListener("click", () => {
      closeModal();
      setModalFoot("");
    });
    pollAppDownloadProgress();
    return;
  }

  if (!status.isDesktop) {
    plainModal(
      "Compakta Update Available",
      `<p class="modal-copy">Compakta <strong>v${escapeHtml(status.latestVersion ?? "")}</strong> is available on GitHub (current: v${escapeHtml(status.currentVersion)}).</p>
       <p class="modal-copy">You are running from a source checkout. Run <code>git pull && bun install</code> to update.</p>`,
      "sm",
    );
    setModalFoot(
      `<button id="btnAppLater" class="btn ghost" type="button">Close</button>` +
      (status.releaseUrl ? `<a href="${escapeHtml(status.releaseUrl)}" target="_blank" class="btn primary" style="display:inline-flex;align-items:center;text-decoration:none">View on GitHub</a>` : ""),
    );
    $("btnAppLater").addEventListener("click", () => {
      closeModal();
      setModalFoot("");
    });
    return;
  }

  // Stage === "available"
  plainModal(
    "New Version of Compakta Available",
    `<p class="modal-copy">Compakta <strong>v${escapeHtml(status.latestVersion ?? "")}</strong> is now available (you are on v${escapeHtml(status.currentVersion)}). Would you like to download it now?</p>
     <div class="fact-list">
       <div class="fact-row"><span>New version</span><span class="mono">v${escapeHtml(status.latestVersion ?? "")}</span></div>
       <div class="fact-row"><span>Current version</span><span class="mono">v${escapeHtml(status.currentVersion)}</span></div>
       <div class="fact-row"><span>Package</span><span>Lean update (${escapeHtml(status.assetName ?? "Setup")})</span></div>
       <div class="fact-row"><span>Download size</span><span>${fmt(status.totalBytes)}</span></div>
     </div>
     <p class="note">The update will download quietly in the background without interrupting your work. You can apply it whenever you are ready.</p>`,
    "sm",
  );

  setModalFoot(
    `<button id="btnAppLater" class="btn ghost" type="button">Not now</button>` +
    `<button id="btnAppDownload" class="btn primary" type="button">Download update</button>`,
  );

  $("btnAppLater").addEventListener("click", () => {
    try {
      if (status.latestVersion) {
        sessionStorage.setItem("appUpdateDismissed", status.latestVersion);
      }
    } catch {}
    closeModal();
    setModalFoot("");
  });

  $("btnAppDownload").addEventListener("click", () => {
    void (async () => {
      try {
        toast(`Downloading Compakta v${status.latestVersion} in the background…`, "info");
        await api("app/update/download", { method: "POST", body: {} });
        status.stage = "downloading";
        status.percent = 0;
        status.message = "Starting download…";
        renderAppPill(status);
        openAppUpdateModal(status);
        pollAppDownloadProgress();
      } catch (err) {
        toast(formatError(err), "danger");
      }
    })();
  });
};

const checkApp = async (force = false, promptUser = false): Promise<AppUpdateStatus> => {
  const status = await api<AppUpdateStatus>(`app/update${force ? "?force=1" : ""}`);
  state.appUpdate = status;
  renderAppPill(status);

  if (status.stage === "downloading") {
    pollAppDownloadProgress();
  } else if (status.stage === "ready") {
    if (promptUser) {
      openAppUpdateModal(status);
    }
  } else if (status.updateAvailable && status.latestVersion) {
    let dismissed = false;
    try {
      dismissed = sessionStorage.getItem("appUpdateDismissed") === status.latestVersion;
    } catch {}

    if (promptUser || !dismissed) {
      openAppUpdateModal(status);
    }
  }
  return status;
};

const handleAppUpdateClick = (): void => {
  if (state.appUpdate) {
    openAppUpdateModal(state.appUpdate);
  } else {
    void checkApp(false, true);
  }
};

// --------------------------------------------------------------------------
// About + quit
// --------------------------------------------------------------------------

const openAbout = (): void => {
  const status = state.status;
  plainModal(
    "About Compakta",
    `<p class="modal-copy">A local-first media optimizer and converter for photos and videos. The source library is only ever read; every output is written to a separate destination and recorded in an undoable manifest.</p>
     <div class="fact-list">
       <div class="fact-row"><span>Version</span><span>v${APP_VERSION}</span></div>
       <div class="fact-row"><span>Check for updates</span><button id="btnAboutCheckUpdate" class="btn ghost sm" type="button">Check now</button></div>
       <div class="fact-row"><span>Platform</span><span>${escapeHtml(platformName(status?.platform ?? ""))} · ${escapeHtml(status?.arch ?? "—")}</span></div>
       <div class="fact-row"><span>ImageMagick</span><span>${status?.magick ? escapeHtml(shortVersion(status.magick.version)) : "not found"}</span></div>
       <div class="fact-row"><span>Destination</span><span class="mono" title="${escapeHtml(status?.destination ?? "")}">${escapeHtml(middlePath(status?.destination ?? "—", 56))}</span></div>
     </div>
     <h3 style="margin:18px 0 8px">Keyboard</h3>
     <div class="fact-list">
       <div class="fact-row"><span>${escapeHtml(modKey())} + Enter</span><span>Start conversion</span></div>
       <div class="fact-row"><span>/</span><span>Focus the library filter</span></div>
       <div class="fact-row"><span>Esc</span><span>Close the current view, drawer, or dialog</span></div>
     </div>`,
    "sm",
  );
  document.getElementById("btnAboutCheckUpdate")?.addEventListener("click", () => {
    closeModal();
    void checkApp(true, true);
  });
};

const showServerStopped = (): void => {
  plainModal(
    "Server closed",
    `<p class="modal-copy ok">Compakta has stopped. You can close this tab.</p>`,
    "sm",
  );
  $("btnQuit").setAttribute("disabled", "disabled");
};

const quitServer = (): void => {
  void (async () => {
    const ok = await ask({
      title: "Close Compakta",
      body: `<p class="modal-copy">Stop the local server?</p>
        <p class="modal-copy">The page will lose its connection. Files already written stay on disk. A running or paused conversion blocks shutdown until it is paused, resumed, or cancelled.</p>`,
      confirmLabel: "Close server",
      danger: true,
    });
    if (!ok) return;
    try {
      await api("shutdown", { method: "POST", body: {} });
      showServerStopped();
    } catch (error) {
      let alive = true;
      try {
        await fetch("/api/status", { cache: "no-store" });
      } catch {
        alive = false;
      }
      if (!alive) {
        showServerStopped();
        return;
      }
      plainModal(
        "Server still running",
        `<p class="modal-copy bad">${escapeHtml(formatError(error))}</p>
         <p class="modal-copy">Pause or cancel the conversion, then try again.</p>`,
        "sm",
      );
    }
  })();
};

// --------------------------------------------------------------------------
// Theme
// --------------------------------------------------------------------------

const themeIds: ThemeId[] = [...THEME_IDS];

const storedTheme = (): ThemeChoice => {
  try {
    const saved = localStorage.getItem("picmagik.theme");
    if (saved === "auto" || themeIds.includes(saved as ThemeId)) return saved as ThemeChoice;
  } catch {
    /* private mode */
  }
  return "auto";
};

const applyTheme = (choice: ThemeChoice, persist = true): void => {
  themeChoice = choice;
  state.themeChoice = choice;
  const resolved = choice === "auto"
    ? (window.matchMedia("(prefers-color-scheme: light)").matches ? "daylight" : "midnight")
    : choice;
  document.documentElement.dataset.theme = resolved;
  if (persist) {
    try {
      localStorage.setItem("picmagik.theme", choice);
    } catch {
      /* private mode */
    }
  }
  const pick = document.getElementById("themePick") as HTMLSelectElement | null;
  if (pick) pick.value = choice;
};

// --------------------------------------------------------------------------
// Rail, shell bindings, shortcuts
// --------------------------------------------------------------------------

const railTargets: Record<string, string> = {
  source: "sourceRoot",
  select: "treeFilter",
  output: "formatCards",
  review: "planHero",
  run: "btnStart",
};

const railStep = (step: string): void => {
  if (step === "run" && (state.run.id || state.running || state.lastSummary)) {
    runView.open();
    return;
  }
  const target = document.getElementById(railTargets[step] ?? "");
  target?.scrollIntoView({ block: "center", behavior: "smooth" });
  if (step === "source") input("sourceRoot").focus();
  if (step === "select") library.focus();
  if (step === "output") {
    if (state.view !== "workspace") switchView("workspace");
    document.querySelector<HTMLButtonElement>("#formatCards .format-card:not(:disabled)")?.focus();
  }
  if (step === "review") {
    if (state.view !== "workspace") switchView("workspace");
    $("planHero").scrollIntoView({ block: "start", behavior: "smooth" });
  }
  if (step === "run") $("btnStart").focus();
};

const closeOverflow = (): void => {
  $("overflowMenu").classList.add("hidden");
  $("btnOverflow").setAttribute("aria-expanded", "false");
};

const toggleOverflow = (): void => {
  const menu = $("overflowMenu");
  const open = menu.classList.contains("hidden");
  menu.classList.toggle("hidden", !open);
  $("btnOverflow").setAttribute("aria-expanded", String(open));
};

// --------------------------------------------------------------------------
// Boot
// --------------------------------------------------------------------------

const boot = async (): Promise<void> => {
  applyTheme(storedTheme(), false);
  initSplitPanes();
  initMicrointeractions();

  try {
    const status = await api<Status>("status");
    applyStatusMeta(status);

    state.excluded = new Set(status.policy.excludedFolders);
    state.included = new Set(status.policy.includedFolders);
    state.excludedFiles = new Set(status.policy.excludedFiles);
    state.includedFiles = new Set(status.policy.includedFiles);
    extEnabled = { ...status.policy.extEnabled };

    input("minsize").value = String(status.policy.minSizeBytes / 1024 ** 2);
    input("copyUndersized").checked = status.policy.copyUndersized;
    input("includeRaw").checked = status.policy.includeRaw;
    input("flattenGif").checked = status.policy.flattenGif;
    input("heicSpeed").value = String(status.policy.heicSpeed);
    input("photoMaxRes").value = String(status.policy.maxResolution ?? 0);
    input("photoSkipLarger").checked = status.policy.skipAlreadyEfficient !== false;
    input("photoStripMeta").checked = Boolean(status.policy.stripMetadata);

    formatUi.init(status);
    renderExtToggles();
    setUndersize(status.policy.copyUndersized);
    updateMinSizeReadout();
    updateJobsReadout();
    updateCpuLimitReadout();
    updateFilmGrainReadout();
    paintRanges();
    updateStartOptions();

    void (async () => {
      try {
        const vStatus = await api<any>("video/status");
        state.videoStatus = vStatus;
        if (!vStatus.ffmpeg) {
          $("ffUpdate").classList.remove("hidden");
        }
      } catch {}
    })();

    if (status.liveJobId) {
      await runLifecycle.attach(status.liveJobId, true);
    }

    if (status.scanned) {
      const scan = await api<ScanResult>("scan", { method: "POST", body: {} });
      library.setScan(scan, false);
      await refreshPreview();
    } else {
      plan.render();
      updateChrome();
    }

    void checkMagick(false).catch((error: unknown) => {
      toast(formatError(error), "warning");
    });
    void checkApp(false).catch((error: unknown) => {
      console.warn("App update check failed:", error);
    });
  } catch (error) {
    toast(formatError(error), "danger");
    plan.render();
    updateChrome();
  } finally {
    state.booted = true;
    document.documentElement.classList.add("booted");
  }
};

// --------------------------------------------------------------------------
// Wire the shell
// --------------------------------------------------------------------------

runView = createRunView(actions);
compareView = createCompareView(actions);
runsView = createRunsView(actions);
healthView = createHealthView(actions);
auditView = createAuditView(actions);

library = createLibrary({
  onChange: () => updateChrome(),
  onPreview: () => schedulePreview(),
  onToast: (message, kind) => toast(message, kind),
  onOpenLightbox: (rel, getFiles) => lightbox.open(rel, getFiles),
});

lightbox = createLightbox(() => library.allFiles());

plan = createPlan({
  onStart: () => void runLifecycle.start(),
  onStartBoth: () => void startBothModes(),
  onEstimate: () => void runEstimate(),
  onSync: () => auditView.open("sync"),
  onCompare: () => compareView.open(),
  onAudit: () => auditView.open("sync"),
  onHealth: () => healthView.open(),
  onReviewBudget: () => {
    if (state.view !== "workspace") switchView("workspace");
    $("folderSection").scrollIntoView({ block: "start", behavior: "smooth" });
  },
});

formatUi = createFormatUi({
  onSelect: (id) => void chooseFormat(id),
  onPreview: () => schedulePreview(),
  onToast: (message) => toast(message, "warning"),
});

runLifecycle = createRunLifecycle({
  policy: activePolicy,
  save,
  render: () => {
    runView.renderDock();
    if (state.view === "run") runView.renderView();
    plan.render();
    updateChrome();
  },
  openRunView: () => runView.open(),
  onFinished: async () => {
    runView.renderDock();
    if (state.view === "run") runView.renderView();
    await refreshPreview();
    await refreshStatus();
    if (queuedNextMode && state.run.state === "done") {
      const next = queuedNextMode;
      queuedNextMode = null;
      toast(`Starting queued ${next === "video" ? "video" : "photo"} conversion…`, "info");
      await switchMediaMode(next);
      await runLifecycle.start();
    } else {
      queuedNextMode = null;
    }
  },
  onError: (message) => toast(message, "danger"),
  onInfo: (message) => toast(message, "success"),
  lockFormat: (locked) => formatUi.lock(locked),
});

$("btnPickSource").addEventListener("click", () => void pickFolder("source"));
$("btnPick").addEventListener("click", () => void pickFolder("destination"));
$("btnScan").addEventListener("click", () => void applySource());
$("sourceRoot").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void applySource();
  }
});

let destinationBefore = "";
input("destination").addEventListener("focus", () => {
  destinationBefore = input("destination").value;
});
input("destination").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    input("destination").blur();
  }
});
input("destination").addEventListener("input", () => {
  if (state.mediaMode === "video") {
    const val = input("destination").value.trim();
    state.videoDestMode = "custom";
    state.videoCustomDestination = val;
    $("btnDestMerge").setAttribute("aria-pressed", "false");
    $("btnDestSubfolder").setAttribute("aria-pressed", "false");
    $("btnDestCustom").setAttribute("aria-pressed", "true");
    $("videoDestResolved").textContent = `Writing to separate custom location: ${val || "…"}`;
    schedulePreview();
  }
});
input("destination").addEventListener("change", () => {
  const previous = destinationBefore || input("destination").value;
  destinationBefore = input("destination").value;
  if (state.mediaMode === "video") {
    const val = input("destination").value.trim();
    state.videoDestMode = "custom";
    state.videoCustomDestination = val;
    syncVideoDestUi();
  }
  if (input("destination").value.trim() !== previous.trim()) {
    void applyDestination(previous);
  }
});

input("minsize").addEventListener("input", () => {
  updateMinSizeReadout();
  paintRange("minsize");
  schedulePreview();
});
$("copyUnder").addEventListener("click", () => setUndersize(true));
$("skipUnder").addEventListener("click", () => setUndersize(false));
input("includeRaw").addEventListener("change", () => schedulePreview());
input("flattenGif").addEventListener("change", () => schedulePreview());
input("photoMaxRes").addEventListener("change", () => schedulePreview());
input("photoSkipLarger").addEventListener("change", () => schedulePreview());
input("photoStripMeta").addEventListener("change", () => schedulePreview());

input("budget").addEventListener("input", () => {
  $("budgetOut").textContent = `${input("budget").value} GB`;
  paintRange("budget");
  schedulePreview();
});

input("jobs").addEventListener("input", () => {
  updateJobsReadout();
  runLifecycle.setJobs(input("jobs").valueAsNumber);
});
input("viewJobs").addEventListener("input", () => {
  $("viewJobsOut").textContent = input("viewJobs").value;
  input("jobs").value = input("viewJobs").value;
  updateJobsReadout();
  paintRange("viewJobs");
  runLifecycle.setJobs(input("viewJobs").valueAsNumber);
});

input("cpuLimit").addEventListener("input", () => {
  updateCpuLimitReadout();
  input("viewCpuLimit").value = input("cpuLimit").value;
  $("viewCpuLimitOut").textContent = `${input("cpuLimit").value}%`;
  paintRange("viewCpuLimit");
  runLifecycle.setCpuLimit(input("cpuLimit").valueAsNumber);
});
input("viewCpuLimit").addEventListener("input", () => {
  $("viewCpuLimitOut").textContent = `${input("viewCpuLimit").value}%`;
  input("cpuLimit").value = input("viewCpuLimit").value;
  updateCpuLimitReadout();
  paintRange("viewCpuLimit");
  runLifecycle.setCpuLimit(input("viewCpuLimit").valueAsNumber);
});

input("overwrite").addEventListener("change", updateStartOptions);
input("onlyNew").addEventListener("change", updateStartOptions);

$("btnPause").addEventListener("click", () => void runLifecycle.pause());
$("viewPause").addEventListener("click", () => void runLifecycle.pause());
$("btnResume").addEventListener("click", () => void runLifecycle.resume());
$("viewResume").addEventListener("click", () => void runLifecycle.resume());
$("btnCancel").addEventListener("click", () => void runLifecycle.cancel());
$("viewCancel").addEventListener("click", () => void runLifecycle.cancel());
$("btnDiscard").addEventListener("click", () => void runLifecycle.cancel());

$("btnHealth").addEventListener("click", () => healthView.open());
$("btnRuns").addEventListener("click", () => {
  closeOverflow();
  runsView.open();
});
$("btnAbout").addEventListener("click", () => {
  closeOverflow();
  openAbout();
});
$("btnAboutBrand").addEventListener("click", openAbout);
$("btnQuit").addEventListener("click", () => {
  closeOverflow();
  quitServer();
});
$("appUpdate").addEventListener("click", handleAppUpdateClick);
$("imUpdate").addEventListener("click", () => void installMagick());
$("ffUpdate").addEventListener("click", () => void installFfmpeg());

$("btnModeImage").addEventListener("click", () => void switchMediaMode("image"));
$("btnModeVideo").addEventListener("click", () => void switchMediaMode("video"));

$("btnPresetArchival").addEventListener("click", () => void applyVideoPreset("archival"));
$("btnPresetBalanced").addEventListener("click", () => void applyVideoPreset("balanced"));
$("btnPresetSpaceSaver").addEventListener("click", () => void applyVideoPreset("spacesaver"));

$("btnDestMerge").addEventListener("click", () => void setVideoDestMode("merge"));
$("btnDestSubfolder").addEventListener("click", () => void setVideoDestMode("subfolder"));
$("btnDestCustom").addEventListener("click", () => void setVideoDestMode("custom"));

input("videoContainer").addEventListener("change", () => schedulePreview());
input("videoMaxRes").addEventListener("change", () => schedulePreview());
input("videoMaxFps").addEventListener("change", () => schedulePreview());
input("videoAudioMode").addEventListener("change", () => schedulePreview());
input("videoFilmGrain").addEventListener("input", () => {
  updateFilmGrainReadout();
  schedulePreview();
});
input("videoTenBit").addEventListener("change", () => schedulePreview());
input("videoSkipEfficient").addEventListener("change", () => schedulePreview());
input("videoCustomParams").addEventListener("input", debounce(() => schedulePreview(), 400));

$("btnOverflow").addEventListener("click", (event) => {
  event.stopPropagation();
  toggleOverflow();
});
$("themePick").addEventListener("change", () => {
  const choice = $<HTMLSelectElement>("themePick").value as ThemeChoice;
  applyTheme(choice);
});

for (const button of document.querySelectorAll<HTMLButtonElement>(".rail-step")) {
  button.addEventListener("click", () => railStep(button.dataset.step ?? ""));
}

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-back]")) {
  button.addEventListener("click", () => switchView("workspace"));
}

$("modalClose").addEventListener("click", () => {
  if (confirmResolve) settleConfirm(false);
  else {
    closeModal();
    setModalFoot("");
  }
});

$<HTMLDialogElement>("modal").addEventListener("close", () => {
  const resolve = confirmResolve;
  confirmResolve = null;
  setModalFoot("");
  resolve?.(false);
});

$("modal").addEventListener("click", (event) => {
  if (event.target !== $("modal")) return;
  if (confirmResolve) settleConfirm(false);
  else {
    closeModal();
    setModalFoot("");
  }
});

document.addEventListener("click", (event) => {
  if (!(event.target as HTMLElement).closest(".overflow-wrap")) closeOverflow();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (lightbox?.isOpen()) {
      lightbox.close();
      return;
    }
    if ($<HTMLDialogElement>("modal").open) {
      if (confirmResolve) settleConfirm(false);
      else {
        closeModal();
        setModalFoot("");
      }
      return;
    }
    if (!$("overflowMenu").classList.contains("hidden")) {
      closeOverflow();
      $("btnOverflow").focus();
      return;
    }
    if (auditView.handleKey(event)) return;
    if (state.view === "compare" && compareView.handleKey(event)) return;
    if (state.view !== "workspace") {
      event.preventDefault();
      switchView("workspace");
    }
    return;
  }

  if (state.view === "compare" && compareView.handleKey(event)) return;

  const tag = (event.target as HTMLElement | null)?.tagName ?? "";
  const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    if (!state.running && !state.starting) void runLifecycle.start();
    return;
  }
  if (event.key === "/" && !typing) {
    event.preventDefault();
    library.focus();
  }
});

window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
  if (themeChoice === "auto") applyTheme("auto", false);
});

window.addEventListener("beforeunload", () => {
  state.es?.close();
});

// The startup theme was already applied inline; sync the picker and boot.
themeChoice = storedTheme();
state.themeChoice = themeChoice;
$<HTMLSelectElement>("themePick").value = themeChoice;
void boot();
