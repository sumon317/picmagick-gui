/**
 * Contracts shared by the full-screen views and main.ts.
 *
 * Views never call the API directly for app-level mutations; they ask the shell
 * through these actions. That keeps policy payloads, preview ordering, and run
 * state in one place.
 */
import type { ToastKind } from "../dom";
import type {
  CompareResponse,
  ManifestSummary,
  OutputFormat,
  Policy,
  ScannedFile,
  UpdateStatus,
  VerifyResponse,
  VideoPolicy,
} from "../types";

export type ConfirmOptions = {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
};

export type ViewActions = {
  switchView: (view: "workspace" | "run" | "compare" | "runs" | "health") => void;
  refreshPreview: () => Promise<void>;
  refreshTree: () => void;
  policy: () => Policy | VideoPolicy;
  toast: (
    message: string,
    kind?: ToastKind,
    action?: { label: string; run: () => void },
  ) => void;
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  startRun: (opts?: { onlyNew?: boolean }) => Promise<void>;
  undoManifest: (id: string, summary?: ManifestSummary) => Promise<void>;
  verifyJob: (jobId: string) => Promise<VerifyResponse>;
  runCompare: (rel: string, format?: OutputFormat, timestampSec?: number) => Promise<CompareResponse>;
  selectedFiles: () => ScannedFile[];
  setQuality: (quality: number, format?: OutputFormat) => void;
  checkMagick: (force?: boolean) => Promise<UpdateStatus>;
  refreshStatusMagick: () => Promise<void>;
  installMagick: () => Promise<void>;
};

export const emptyState = (iconName: string, title: string, note: string): string =>
  `<div class="empty-state">
     <svg width="24" height="24" aria-hidden="true"><use href="#i-${iconName}"></use></svg>
     <p class="empty-title">${title}</p>
     <p class="empty-note">${note}</p>
   </div>`;

export const checkIcon = (status: "ok" | "warn" | "fail"): string => {
  if (status === "ok") return "check-circle";
  if (status === "warn") return "alert-triangle";
  return "alert-octagon";
};

export const statusWord = (status: "ok" | "warn" | "fail"): string =>
  status === "ok" ? "OK" : status === "warn" ? "Warning" : "Failed";

export const relativeToNow = (timestamp: number | null): string => {
  if (!timestamp) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  return new Date(timestamp).toLocaleDateString();
};
