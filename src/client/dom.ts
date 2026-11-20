/**
 * DOM utilities shared by every view.
 *
 * The helpers are deliberately small and framework-free. Interactive controls
 * are real buttons/inputs; state is expressed with aria/data attributes, never
 * by styling classes alone.
 */

export const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
};

export const maybe = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null;

export const input = (id: string): HTMLInputElement => $<HTMLInputElement>(id);
export const select = (id: string): HTMLSelectElement => $<HTMLSelectElement>(id);

export const escapeHtml = (value: unknown): string =>
  String(value).replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });

/** Byte formatter shared with the old UI so numbers never disagree. */
export const fmt = (n: number | null | undefined): string => {
  if (n == null || !Number.isFinite(n)) return "–";
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + " GB";
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
  return Math.round(n) + " B";
};

export const pct = (n: number | null | undefined, digits = 0): string =>
  n == null || !Number.isFinite(n) ? "–" : `${n.toFixed(digits)}%`;

export const count = (n: number | null | undefined): string =>
  n == null || !Number.isFinite(n) ? "–" : n.toLocaleString();

export const dur = (seconds: number | null | undefined): string => {
  if (seconds == null || !Number.isFinite(seconds)) return "–";
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m ${String(s % 60).padStart(2, "0")}s`;
};

export const eta = (seconds: number | null | undefined): string => {
  if (seconds == null || !Number.isFinite(seconds)) return "–";
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
  return dur(seconds);
};

export const clamp = (n: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, n));

/** SVG sprite reference. The sprite is in index.html; no external assets. */
export const icon = (name: string, size = 16, className = "icon"): string =>
  `<svg class="${className}" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><use href="#i-${name}"></use></svg>`;

export const setHidden = (node: HTMLElement, hidden: boolean): void => {
  node.hidden = hidden;
};

export const setText = (id: string, text: string): void => {
  const node = maybe(id);
  if (node) node.textContent = text;
};

export const setWidth = (node: HTMLElement, fraction: number): void => {
  node.style.transform = `scaleX(${clamp(fraction, 0, 1)})`;
};

export const debounce = <A extends unknown[]>(
  fn: (...args: A) => void,
  delay: number,
): ((...args: A) => void) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
};

export type FrameCoalescer = {
  /** Ask for fn to run at most once per frame; N calls collapse into one. */
  request: () => void;
  /** Run fn immediately (state transitions), cancelling any queued frame. */
  flush: () => void;
  /** True while a frame is still outstanding (probe/testing hook). */
  pending: () => boolean;
};

/**
 * Collapse high-frequency renders (per-file SSE progress) to at most one per
 * animation frame. The scheduler is injectable so bun probes can drive it
 * deterministically; browsers get requestAnimationFrame, with a setTimeout
 * fallback for hidden windows where rAF is throttled/paused. fn is not re-entrant
 * through request(): a flush() during a queued frame clears the queue, and the
 * later frame callback sees queued === false and becomes a no-op.
 */
export function createFrameCoalescer(
  fn: () => void,
  schedule: (cb: () => void) => void =
    typeof requestAnimationFrame === "function"
      ? (cb) => void requestAnimationFrame(cb)
      : (cb) => void setTimeout(cb, 16),
): FrameCoalescer {
  let queued = false;
  const run = (): void => {
    if (!queued) return;
    queued = false;
    fn();
  };
  return {
    request: (): void => {
      if (queued) return;
      queued = true;
      schedule(run);
    },
    flush: (): void => {
      queued = false;
      fn();
    },
    pending: (): boolean => queued,
  };
}

export type ToastKind = "info" | "success" | "warning" | "danger";

const toastIcon: Record<ToastKind, string> = {
  info: "info",
  success: "check-circle",
  warning: "alert-triangle",
  danger: "alert-octagon",
};

/**
 * Stacked, dismissible toasts. Errors stay until dismissed; confirmations leave
 * on their own. A toast is never the only record of a run or a destructive act.
 */
export function toast(message: string, kind: ToastKind = "info", action?: { label: string; run: () => void }): void {
  const host = maybe("toasts");
  if (!host) return;

  const node = document.createElement("div");
  node.className = `toast toast-${kind}`;
  node.setAttribute("role", kind === "danger" ? "alert" : "status");
  node.innerHTML =
    `<span class="toast-icon">${icon(toastIcon[kind], 16)}</span>` +
    `<span class="toast-text">${escapeHtml(message)}</span>` +
    (action ? `<button class="toast-action" type="button">${escapeHtml(action.label)}</button>` : "") +
    `<button class="toast-close" type="button" aria-label="Dismiss">${icon("x", 14)}</button>`;

  const dismiss = (): void => {
    if (!node.isConnected) return;
    node.classList.add("toast-out");
    window.setTimeout(() => node.remove(), 180);
  };

  node.querySelector<HTMLButtonElement>(".toast-close")?.addEventListener("click", dismiss);
  if (action) {
    node.querySelector<HTMLButtonElement>(".toast-action")?.addEventListener("click", () => {
      action.run();
      dismiss();
    });
  }

  host.append(node);
  while (host.children.length > 3) host.firstElementChild?.remove();

  if (kind !== "danger") {
    const timer = window.setTimeout(dismiss, kind === "warning" ? 8000 : 4500);
    node.addEventListener("mouseenter", () => window.clearTimeout(timer), { once: true });
  }
}

/** Centered modal. Callers render their own body; main.ts owns the close button. */
export function openModal(title: string, html: string, size: "sm" | "md" | "lg" = "md"): HTMLDialogElement {
  const dialog = $<HTMLDialogElement>("modal");
  const titleNode = $("modalTitle");
  const body = $("modalBody");
  titleNode.textContent = title;
  body.innerHTML = html;
  dialog.dataset.size = size;
  if (!dialog.open) dialog.showModal();
  window.setTimeout(() => {
    body.querySelector<HTMLElement>("button, input, select, textarea, [tabindex='0']")?.focus();
  }, 40);
  return dialog;
}

export function closeModal(): void {
  const dialog = maybe<HTMLDialogElement>("modal");
  if (dialog?.open) dialog.close();
}

export const shortVersion = (version: string | null | undefined): string => {
  const text = String(version ?? "");
  return text.match(/\d+\.\d+\.\d+(?:-\d+)?/)?.[0] ?? (text.split(/\s+/)[0] || "?");
};

export const relativeTime = (timestamp: number | null | undefined): string => {
  if (!timestamp) return "never";
  const diff = Date.now() - timestamp;
  if (diff < 45_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} h ago`;
  return new Date(timestamp).toLocaleDateString();
};

export const absoluteTime = (timestamp: number | null | undefined): string => {
  if (!timestamp) return "–";
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** Middle-truncate a path while keeping both ends readable. */
export const middlePath = (path: string, max = 54): string => {
  if (path.length <= max) return path;
  const keep = Math.floor((max - 1) / 2);
  return `${path.slice(0, keep)}…${path.slice(-keep)}`;
};

export const isMac = (): boolean => /mac/i.test(navigator.platform || "");
export const modKey = (): string => (isMac() ? "⌘" : "Ctrl");
