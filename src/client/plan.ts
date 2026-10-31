/**
 * Plan pane: the projection, budget, warnings, folder split, pre-flight row, and
 * the sticky Start control.
 *
 * Every number is copied from /api/preview or /api/estimate. The plan never
 * extrapolates from row counts on its own.
 */
import { $, escapeHtml, fmt, icon, setWidth } from "./dom";
import { state } from "./state";
import type { FolderRollup, HealthReport, PreviewResponse } from "./types";

export type PlanOptions = {
  onStart: () => void;
  onStartBoth?: () => void;
  onEstimate: () => void;
  onSync: () => void;
  onCompare: () => void;
  onAudit: () => void;
  onHealth: () => void;
  onReviewBudget: () => void;
};

export type PlanController = {
  render: () => void;
};

type Warning = {
  severity: "info" | "warning" | "blocker" | "success";
  title: string;
  body: string;
  action?: { label: string; kind: "health" | "budget" };
};

const warningIcon = (severity: Warning["severity"]): string => {
  if (severity === "blocker") return "alert-octagon";
  if (severity === "warning") return "alert-triangle";
  if (severity === "success") return "check-circle";
  return "info";
};

const folderRows = (p: PreviewResponse): string => {
  if (!p.byFolder.length) {
    return `<p class="empty-note">No files are selected yet.</p>`;
  }
  const max = Math.max(1, ...p.byFolder.map((folder) => folder.estOutputBytes));
  return p.byFolder
    .slice(0, 12)
    .map((folder: FolderRollup) => {
      const count = folder.convertCount + folder.copyCount;
      const width = Math.max(2, (folder.estOutputBytes / max) * 100);
      return `<div class="folder-row">
        <span class="folder-name" title="${escapeHtml(folder.rel)}">${escapeHtml(folder.rel)}</span>
        <span class="folder-counts">${count.toLocaleString()} files</span>
        <span class="folder-counts">${fmt(folder.estOutputBytes)}</span>
        <div class="folder-bar" aria-hidden="true"><div style="width:${width.toFixed(1)}%"></div></div>
      </div>`;
    })
    .join("");
};

const healthWarnings = (health: HealthReport | null): Warning[] => {
  if (!health) return [];
  const out: Warning[] = [];
  const failed = health.checks.filter((check) => check.status === "fail");
  const warned = health.checks.filter((check) => check.status === "warn");
  for (const check of failed.slice(0, 2)) {
    out.push({
      severity: "blocker",
      title: check.label,
      body: check.detail,
      action: { label: "Open health", kind: "health" },
    });
  }
  if (failed.length > 2) {
    out.push({
      severity: "blocker",
      title: `${failed.length - 2} more blocking checks`,
      body: "Open Health to see every check before starting.",
      action: { label: "Open health", kind: "health" },
    });
  }
  for (const check of warned.slice(0, 2)) {
    out.push({ severity: "warning", title: check.label, body: check.detail });
  }
  return out;
};

const warningsFor = (p: PreviewResponse): Warning[] => {
  const out: Warning[] = [];
  const total = p.convert + p.copy;

  if (!total) {
    out.push({
      severity: "info",
      title: "Nothing selected",
      body: "Use the Library pane or the Select step to include at least one image.",
    });
  }

  if (!p.budget.fits) {
    const first = p.budget.dropSuggestions[0];
    out.push({
      severity: "warning",
      title: `Over budget by ${fmt(p.budget.overBy)}`,
      body: first
        ? `Dropping ${first.rel} would bring the plan to ${fmt(first.runningTotalAfterDrop)}${first.getsUnderBudget ? " — under budget." : ", still over budget."}`
        : "The projected output is larger than the storage budget.",
      action: { label: "Review by folder", kind: "budget" },
    });
  }

  if (p.freeBytes != null && p.estOutputBytes > p.freeBytes) {
    out.push({
      severity: "blocker",
      title: "Not enough free space",
      body: `The plan needs ${fmt(p.estOutputBytes)}, but only ${fmt(p.freeBytes)} is free on the destination volume.`,
    });
  }

  if (p.health) {
    out.push(...healthWarnings(p.health));
  }

  if (p.skip > 0) {
    out.push({
      severity: "info",
      title: `${p.skip.toLocaleString()} file${p.skip === 1 ? "" : "s"} will be skipped`,
      body: "They are outside the selected source types, under the size floor, or excluded by the recipe.",
    });
  }

  const scan = state.lastScan;
  if (scan?.riskyNames.length) {
    out.push({
      severity: "warning",
      title: `${scan.riskyNames.length} risky folder name${scan.riskyNames.length === 1 ? "" : "s"}`,
      body: "A non-standard slash character can break copied paths. Review the Library before running.",
    });
  }
  if (scan?.deadFolders.length) {
    out.push({
      severity: "info",
      title: `${scan.deadFolders.length} empty/non-media folder${scan.deadFolders.length === 1 ? "" : "s"} ignored`,
      body: "These folders contain nothing convertible. They are left out of the plan.",
    });
  }
  if (scan && scan.skipped.length) {
    out.push({
      severity: "info",
      title: `${scan.skipped.length} file${scan.skipped.length === 1 ? "" : "s"} skipped during scan`,
      body: "Files that could not be read are left out of the plan.",
    });
  }

  if ((state.status?.redundantRoots ?? []).length === 0 && total > 0) {
    out.push({
      severity: "info",
      title: "Originals are the only copy",
      body: "Conversion never modifies them. Keep a separate backup before any cleanup.",
    });
  }

  if (state.running) {
    out.push({
      severity: "info",
      title: "A run is in progress",
      body: "The Plan updates after the run finishes. Open Run to watch live progress.",
    });
  }

  return out;
};

export function createPlan(opts: PlanOptions): PlanController {
  const warningHost = $("planWarnings");

  const render = (): void => {
    const p = state.preview;
    const spec = state.formatSpecs[state.currentFormat];

    if (!p) {
      $("planHeroFrom").textContent = "–";
      $("planHeroTo").textContent = "–";
      $("planHeroSub").textContent = "Scan a library to see what will be produced.";
      const delta = document.getElementById("planHeroDelta");
      if (delta) delta.textContent = "";
      for (const id of ["statConvert", "statCopy", "statSkip"]) $(id).textContent = "–";
      $("statOut").textContent = "–";
      $("budgetNote").textContent = "No scan yet.";
      $("budgetFill").style.transform = "scaleX(0)";
      $("budgetFill").classList.remove("over");
      warningHost.innerHTML = "";
      $("folderSplit").innerHTML = `<p class="empty-note">Scan a library to see the folder split.</p>`;
      $("folderMeta").textContent = "";
      $("planHeadMeta").textContent = "Waiting for scan";
      $<HTMLButtonElement>("btnStart").disabled = true;
      $("btnStart").textContent = "Start conversion";
      $("startHint").textContent = "Choose a source folder to begin.";
      $("syncMeta").textContent = "what's new";
      $("estimateMeta").textContent = "real sample";
      $("compareMeta").textContent = "visual";
      $("auditMeta").textContent = "3 reports";
      return;
    }

    const totalBytes = p.sourceBytes;
    const saved = totalBytes > 0 ? 100 - (p.estOutputBytes / totalBytes) * 100 : null;
    $("planHeroFrom").textContent = fmt(totalBytes);
    $("planHeroTo").textContent = fmt(p.estOutputBytes);
    const delta = document.getElementById("planHeroDelta");
    if (delta) {
      delta.textContent = saved == null
        ? ""
        : `${saved >= 0 ? "−" : "+"}${Math.abs(saved).toFixed(0)}%`;
      delta.dataset.tone = saved != null && saved >= 0 ? "good" : "bad";
    }
    $("planHeroSub").textContent = `${p.formatLabel} q${spec ? Math.round(Number($<HTMLInputElement>("quality").value)) : "—"} · ${p.estOutputFiles.toLocaleString()} output files`;

    $("statConvert").textContent = p.convert.toLocaleString();
    $("statCopy").textContent = p.copy.toLocaleString();
    $("statSkip").textContent = p.skip.toLocaleString();
    $("statOut").textContent = fmt(p.estOutputBytes);

    const budget = p.budget;
    const frac = budget.budgetBytes > 0 ? budget.totalEstBytes / budget.budgetBytes : 0;
    setWidth($("budgetFill"), frac);
    $("budgetFill").classList.toggle("over", !budget.fits);
    $("budgetCard").classList.toggle("over", !budget.fits);
    let budgetNote = "";
    if (!budget.fits) {
      budgetNote = `Over the ${fmt(budget.budgetBytes)} budget by ${fmt(budget.overBy)}. `;
      const first = budget.dropSuggestions[0];
      if (first) {
        budgetNote += `Dropping "${first.rel}" would bring it to ${fmt(first.runningTotalAfterDrop)}` +
          (first.getsUnderBudget ? " (under budget)." : ", still not enough.");
      }
    } else {
      budgetNote = `Fits the ${fmt(budget.budgetBytes)} budget · ${(frac * 100).toFixed(2)}% used.`;
    }
    const otherBytes = p.otherModeBytes ?? 0;
    const otherCount = p.otherModeCount ?? 0;
    if (otherCount > 0) {
      const combined = budget.totalEstBytes + otherBytes;
      const otherLabel = state.mediaMode === "video" ? "photos" : "videos";
      budgetNote += ` · Combined with ${otherCount.toLocaleString()} ${otherLabel}: ${fmt(combined)} / ${fmt(budget.budgetBytes)}.`;
    }
    $("budgetNote").textContent = budgetNote;
    $("budgetNoteShort").textContent = `Headroom for the projected output. Currently ${fmt(budget.budgetBytes)}.`;

    $("planHeadMeta").textContent = `${p.formatLabel} · ${p.estOutputFiles.toLocaleString()} outputs`;

    const warnings = warningsFor(p);
    warningHost.innerHTML = warnings
      .map((warning) => `<div class="warning-card" data-severity="${warning.severity}">
        <span class="warning-icon">${icon(warningIcon(warning.severity), 15)}</span>
        <span class="warning-text"><b>${escapeHtml(warning.title)}</b>${warning.body ? `<br>${escapeHtml(warning.body)}` : ""}</span>
        ${warning.action ? `<button class="warning-action" type="button" data-plan-action="${warning.action.kind}">${escapeHtml(warning.action.label)}</button>` : ""}
      </div>`)
      .join("");

    $("folderSplit").innerHTML = folderRows(p);
    $("folderMeta").textContent = `${p.byFolder.length.toLocaleString()} folder${p.byFolder.length === 1 ? "" : "s"} in scope`;

    const canRun = p.health?.canRun !== false;
    const total = p.convert + p.copy;
    $<HTMLButtonElement>("btnStart").disabled = state.running || state.starting || total === 0 || !canRun;
    $("btnStart").textContent = state.running
      ? "Run in progress"
      : state.starting
        ? "Starting…"
        : total > 0
          ? `Convert ${total.toLocaleString()} file${total === 1 ? "" : "s"}`
          : "Nothing selected";
    const estimate = state.lastEstimate;
    const projection = `${fmt(p.sourceBytes)} → ${fmt(p.estOutputBytes)}`;
    const time = estimate ? ` · ~${fmtDuration(estimate.projectedSeconds)}` : "";
    $("startHint").textContent = state.running
      ? "Progress is in the floating run dock."
      : total === 0
        ? "Include at least one file in the Library."
        : `${projection}${time} · undo available after the run`;

    const btnBoth = document.getElementById("btnStartBoth") as HTMLButtonElement | null;
    if (btnBoth) {
      const showBoth = !state.running && !state.starting && total > 0 && otherCount > 0 && canRun;
      btnBoth.classList.toggle("hidden", !showBoth);
      btnBoth.disabled = !showBoth;
      btnBoth.textContent = `Convert All (${total.toLocaleString()} ${state.mediaMode === "video" ? "videos" : "photos"} + ${otherCount.toLocaleString()} ${state.mediaMode === "video" ? "photos" : "videos"})`;
    }

    $("syncMeta").textContent = state.lastSync
      ? `${state.lastSync.pendingCount.toLocaleString()} pending`
      : "what's new";
    $("estimateMeta").textContent = estimate
      ? `${estimate.sampleSize.toLocaleString()} sampled`
      : "real sample";
    $("compareMeta").textContent = total ? `${Math.min(6, total)} picks` : "visual";
    $("auditMeta").textContent = "3 reports";
  };

  $("btnStart").addEventListener("click", opts.onStart);
  const btnStartBoth = document.getElementById("btnStartBoth");
  btnStartBoth?.addEventListener("click", () => opts.onStartBoth?.());
  $("btnEstimate").addEventListener("click", opts.onEstimate);
  $("btnSync").addEventListener("click", opts.onSync);
  $("btnCompare").addEventListener("click", opts.onCompare);
  $("btnAudit").addEventListener("click", opts.onAudit);

  warningHost.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-plan-action]");
    if (!target) return;
    if (target.dataset.planAction === "health") opts.onHealth();
    if (target.dataset.planAction === "budget") opts.onReviewBudget();
  });

  return { render };
}

const fmtDuration = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
};
