/**
 * Full-screen Compare view matching the inspector mockup.
 *
 * Provides:
 * - Top header with file picker, format switcher, mode dropdown, zoom range slider & close.
 * - Interactive split canvas with neon cyan divider and draggable ( ↔ ) handle.
 * - Floating frosted glass badges for original and encoded variant.
 * - Floating bottom canvas dock with quick Fit/100%, mode toggles, background switcher & fullscreen.
 * - Right inspector sidebar with FILE metadata, QUALITY LADDER with 5-segment meters,
 *   and glowing Use qXX / Set as default actions.
 */
import { $, escapeHtml, fmt } from "../dom";
import { state } from "../state";
import type { CompareResponse, CompareVariant, OutputFormat } from "../types";
import type { ViewActions } from "./shared";
import { emptyState } from "./shared";

let avifDecodePromise: Promise<boolean> | null = null;
const canDecodeAvif = (): Promise<boolean> => {
  if (avifDecodePromise) return avifDecodePromise;
  avifDecodePromise = new Promise<boolean>((resolve) => {
    const probe = new Image();
    probe.onload = () => resolve(probe.naturalWidth > 0 && probe.naturalHeight > 0);
    probe.onerror = () => resolve(false);
    probe.src =
      "data:image/avif;base64,AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAADybWV0YQAAAAAAAAAoaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAGxpYmF2aWYAAAAADnBpdG0AAAAAAAEAAAAeaWxvYwAAAABEAAABAAEAAAABAAABGgAAAB0AAAAoaWluZgAAAAAAAQAAABppbmZlAgAAAAABAABhdjAxQ29sb3IAAAAAamlwcnAAAABLaXBjbwAAABRpc3BlAAAAAAAAAAIAAAACAAAAEHBpeGkAAAAAAwgICAAAAAxhdjFDgQ0MAAAAABNjb2xybmNseAACAAIAAYAAAAAXaXBtYQAAAAAAAAABAAEEAQKDBAAAACVtZGF0EgAKCBgANogQEAwgMg8f8D///8WfhwB8+ErK42A=";
  });
  return avifDecodePromise;
};

/** Format seconds as M:SS for the frame scrubber. */
const fmtTime = (sec: number): string => {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export type CompareViewController = {
  open: (rel?: string) => void;
  close: () => void;
  handleKey: (event: KeyboardEvent) => boolean;
};

export function createCompareView(actions: ViewActions): CompareViewController {
  let split = 50;
  let dimensions: { width: number; height: number } | null = null;
  let activeRunSeq = 0;
  let compareAbort: AbortController | null = null;
  let compareBg: "checker" | "dark" | "light" = "checker";
  let activeFormat: OutputFormat = state.currentFormat;
  let isDraggingSplitter = false;
  let stagePointerBound = false;
  let panX = 0;
  let panY = 0;
  let isPanning = false;

  const applyImageTransforms = (): void => {
    const stage = $("compareStage");
    const imgs = stage.querySelectorAll<HTMLImageElement>(".compare-pane img");
    if (!imgs.length) return;
    const transform = state.compareZoom > 0
      ? `translate(${panX}px, ${panY}px) scale(${state.compareZoom})`
      : "";
    imgs.forEach((img) => {
      img.style.transform = transform;
      img.style.transformOrigin = "center center";
    });
  };

  const fileList = () => actions.selectedFiles();

  // The <select> only lists up to this many files; arrow-key navigation and the
  // per-file Compare action still reach every selected file (they use
  // fileList() directly). Rendering 5k+ <option> nodes per rebuild froze the
  // view, and the rebuild ran on every renderStage (ladder click, mode change).
  const FILE_SELECT_CAP = 1000;
  let fileSelectCache: { key: string; html: string } | null = null;

  const syncFileSelect = (rel: string | null): void => {
    const select = $<HTMLSelectElement>("compareFileSelect");
    const files = fileList();
    const nameOf = (value: string): string => value.split(/[\\/]/).pop() ?? value;
    const inList = rel ? files.some((f) => f.rel === rel) : false;
    const overflow = Math.max(0, files.length - FILE_SELECT_CAP);
    const shown = overflow ? files.slice(0, FILE_SELECT_CAP) : files;
    // Cache on the selection shape only; the chosen entry is applied via
    // select.value so ladder/mode re-renders never rebuild the option list.
    const key = `${files.length}|${files[0]?.rel ?? ""}|${files[files.length - 1]?.rel ?? ""}`;
    if (!fileSelectCache || fileSelectCache.key !== key) {
      fileSelectCache = {
        key,
        html:
          shown
            .map((f) => `<option value="${escapeHtml(f.rel)}">${escapeHtml(nameOf(f.rel))}</option>`)
            .join("") +
          (overflow
            ? `<option value="" disabled>… ${(overflow).toLocaleString()} more selected files (use the per-file Compare button or arrow keys)</option>`
            : ""),
      };
    }
    if (rel && !inList) {
      // A per-file Compare action can open a file that is not selected.
      select.innerHTML =
        `<option value="${escapeHtml(rel)}" selected>${escapeHtml(nameOf(rel))}</option>` + fileSelectCache.html;
      return;
    }
    select.innerHTML = fileSelectCache.html;
    if (rel) select.value = rel;
  };

  const syncFormatSelect = (current: OutputFormat): void => {
    const select = $<HTMLSelectElement>("compareFormatSelect");
    const specs = Object.values(state.formatSpecs);
    if (!specs.length) {
      select.innerHTML = `<option value="${current}" selected>${current.toUpperCase()}</option>`;
      return;
    }
    select.innerHTML = specs
      .map(
        (s) =>
          `<option value="${s.id}"${s.id === current ? " selected" : ""}>${escapeHtml(s.shortLabel || s.label)}</option>`,
      )
      .join("");
  };

  const syncModeSelect = (mode: "split" | "side" | "toggle"): void => {
    const select = $<HTMLSelectElement>("compareModeSelect");
    if (select) select.value = mode;

    for (const button of $("compareModes").querySelectorAll<HTMLButtonElement>("button")) {
      button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
    }

    const dock = document.getElementById("canvasDock");
    if (dock) {
      for (const btn of dock.querySelectorAll<HTMLButtonElement>("[data-dock-mode]")) {
        btn.classList.toggle("active", btn.dataset.dockMode === mode);
      }
    }
  };

  const formatDate = (mtime?: number): string => {
    // No mtime → nothing: a fabricated "Captured …" date is worse than none.
    if (!mtime) return "";
    const d = new Date(mtime);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `Captured ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const renderFacts = (data: CompareResponse, _variant: CompareVariant | undefined): void => {
    const origExt = data.originalExt ? data.originalExt.replace(/^\./, "").toUpperCase() : "JPEG";
    const dimText = dimensions ? `${dimensions.width} × ${dimensions.height}` : "Loading…";
    const dateText = formatDate(data.mtime);
    const pathText = data.rel;

    $("compareFacts").innerHTML = `
      <div class="meta-line-primary">${dimText} · ${escapeHtml(origExt)} · ${fmt(data.originalBytes)}</div>
      ${dateText ? `<div class="meta-line-secondary">${escapeHtml(dateText)}</div>` : ""}
      <div class="meta-line-secondary" title="${escapeHtml(pathText)}">${escapeHtml(pathText)}</div>
    `;
  };

  const calculateSignalBars = (index: number, total: number, quality: number): number => {
    if (total <= 1) return 3;
    if (quality <= 35) return 1;
    if (quality <= 55) return 2;
    if (quality <= 65) return 3;
    if (quality <= 75) return 4;
    return 5;
  };

  const renderLadder = (data: CompareResponse): void => {
    const host = $("compareLadder");
    const total = data.variants.length;
    host.innerHTML = data.variants
      .map((variant, index) => {
        const active = index === state.compareVariant;
        const saving =
          data.originalBytes > 0
            ? Math.max(0, 100 - (variant.bytes / data.originalBytes) * 100)
            : 0;
        const savingText = `${saving.toFixed(1)}% smaller`;
        const litBars = calculateSignalBars(index, total, variant.quality);

        let barsHtml = "";
        for (let b = 1; b <= 5; b++) {
          barsHtml += `<span class="signal-bar${b <= litBars ? " lit" : ""}"></span>`;
        }

        return `
          <div class="ladder-card${active ? " active" : ""}" data-variant-index="${index}" data-quality="${variant.quality}">
            <div class="ladder-radio">${active ? '<span class="radio-pip"></span>' : ""}</div>
            <span class="ladder-q">q${variant.quality}</span>
            <span class="ladder-stats">${fmt(variant.bytes)} <span class="ladder-pct">(${savingText})</span></span>
            <div class="signal-meter">${barsHtml}</div>
          </div>
        `;
      })
      .join("");

    updateActionsFootnote(data);
  };

  const updateActionsFootnote = (data: CompareResponse): void => {
    const variant = data.variants[Math.min(state.compareVariant, data.variants.length - 1)];
    const applyBtn = document.getElementById("btnCompareApply");
    if (applyBtn && variant) {
      applyBtn.textContent = `Use q${variant.quality}`;
    }

    const footnote = document.getElementById("compareFootnote");
    if (footnote && variant) {
      const spec = state.formatSpecs[data.format];
      const notes = [spec?.transparencyNote, spec?.animationNote].filter(Boolean).join(" ");
      footnote.textContent = `${notes ? notes + " " : ""}q${variant.quality} is selected.`;
    }
  };

  const renderStage = (): void => {
    const data = state.compare;
    const stage = $("compareStage");
    if (!data || !data.variants.length) {
      stage.classList.add("hidden");
      $("compareRail").classList.add("hidden");
      $("compareEmpty").classList.remove("hidden");
      return;
    }

    const variant = data.variants[Math.min(state.compareVariant, data.variants.length - 1)];
    state.compareVariant = data.variants.indexOf(variant);
    const zoomScale = state.compareZoom > 0 ? state.compareZoom : 1;
    const scale = state.compareZoom > 0 ? `transform: scale(${zoomScale});` : "";
    const showOriginal = state.compareShowOriginal;

    stage.dataset.mode = state.compareMode;
    stage.dataset.bg = compareBg;
    stage.style.setProperty("--split", `${split}%`);

    const formatLabel = data.format.toUpperCase();
    const saving =
      data.originalBytes > 0
        ? Math.max(0, 100 - (variant.bytes / data.originalBytes) * 100)
        : 0;
    const savingText = `${saving.toFixed(1)}% smaller`;

    let stageHtml = "";

    // Image Panes
    const splitClip =
      state.compareMode === "split"
        ? `-webkit-clip-path: inset(0 0 0 ${split}%); clip-path: inset(0 0 0 ${split}%);`
        : "";
    stageHtml += `
      <div class="compare-pane original${state.compareMode === "toggle" && !showOriginal ? " hidden" : ""}">
        <img src="${escapeHtml(data.originalUrl)}" alt="Original" draggable="false" style="${scale}">
      </div>
      <div class="compare-pane variant${state.compareMode === "toggle" && showOriginal ? " hidden" : ""}" style="${splitClip}">
        <img src="${escapeHtml(variant.url)}" alt="${escapeHtml(variant.label)} variant" draggable="false" style="${scale}">
      </div>
    `;

    // Split Line & Center Handle in Split Mode
    if (state.compareMode === "split") {
      stageHtml += `
        <div class="compare-split-line" style="left: ${split}%"></div>
        <div class="compare-split-handle" style="left: ${split}%" aria-label="Splitter handle" role="separator" aria-valuenow="${Math.round(split)}">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="m9 18-6-6 6-6"/>
            <path d="m15 6 6 6-6 6"/>
            <path d="M3 12h18"/>
          </svg>
        </div>
      `;
    }

    // Floating Badges
    if (state.compareMode === "split") {
      stageHtml += `
        <div class="frosted-badge stage-badge-top-left">
          <span class="badge-title">ORIGINAL</span>
          <span class="badge-sub">${fmt(data.originalBytes)}</span>
        </div>
        <div class="frosted-badge stage-badge-top-right">
          <span class="badge-title">${escapeHtml(formatLabel)} q${variant.quality}</span>
          <span class="badge-sub">${fmt(variant.bytes)} (${savingText})</span>
        </div>
      `;
    } else if (state.compareMode === "side") {
      stageHtml += `
        <div class="frosted-badge stage-badge-top-left">
          <span class="badge-title">ORIGINAL</span>
          <span class="badge-sub">${fmt(data.originalBytes)}</span>
        </div>
        <div class="frosted-badge stage-badge-top-right">
          <span class="badge-title">${escapeHtml(formatLabel)} q${variant.quality}</span>
          <span class="badge-sub">${fmt(variant.bytes)} (${savingText})</span>
        </div>
      `;
    } else {
      stageHtml += `
        <div class="frosted-badge stage-badge-top-left">
          <span class="badge-title">${showOriginal ? "ORIGINAL" : `${escapeHtml(formatLabel)} q${variant.quality}`}</span>
          <span class="badge-sub">${fmt(showOriginal ? data.originalBytes : variant.bytes)}</span>
        </div>
      `;
    }

    // Bottom Canvas Dock
    stageHtml += `
      <div class="canvas-dock" id="canvasDock">
        <div class="dock-group">
          <button id="btnDockFit" class="dock-btn${state.compareZoom === 0 ? " active" : ""}" type="button">Fit</button>
          <button id="btnDock100" class="dock-btn${state.compareZoom === 1 ? " active" : ""}" type="button">100%</button>
        </div>
        <span class="dock-sep"></span>
        <div class="dock-group" id="dockModeGroup">
          <button class="dock-btn${state.compareMode === "toggle" ? " active" : ""}" data-dock-mode="toggle" type="button">Original only</button>
          <button class="dock-btn${state.compareMode === "split" ? " active" : ""}" data-dock-mode="split" type="button">Split</button>
          <button class="dock-btn${state.compareMode === "side" ? " active" : ""}" data-dock-mode="side" type="button">Side-by-side</button>
        </div>
        <span class="dock-sep"></span>
        <div class="dock-select-wrap">
          <select id="compareBgSelect" class="dock-select" aria-label="Canvas background">
            <option value="checker"${compareBg === "checker" ? " selected" : ""}>Background: Checker</option>
            <option value="dark"${compareBg === "dark" ? " selected" : ""}>Background: Dark</option>
            <option value="light"${compareBg === "light" ? " selected" : ""}>Background: Light</option>
          </select>
        </div>
        <span class="dock-sep"></span>
        ${
          data.durationSec && data.durationSec > 1.5
            ? `<div class="dock-group" title="Scrub video frame timestamp">
                 <span class="mono" style="font-size:11px;color:var(--text-secondary)">Frame</span>
                 <input id="compareTimeSlider" type="range" min="0" max="${Math.max(1, Number((data.durationSec - 1).toFixed(1)))}" step="0.5" value="${Number(data.timestampSec ?? 0).toFixed(1)}" style="width:92px">
                 <span id="compareTimeOut" class="mono" style="font-size:11px;min-width:34px">${fmtTime(data.timestampSec ?? 0)}</span>
               </div>
               <span class="dock-sep"></span>`
            : ""
        }
        <button id="btnDockFullscreen" class="dock-btn icon-btn" type="button" title="Toggle fullscreen" aria-label="Toggle fullscreen">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>
          </svg>
        </button>
      </div>
    `;

    stage.innerHTML = stageHtml;
    stage.classList.remove("hidden");
    $("compareEmpty").classList.add("hidden");
    $("compareRail").classList.remove("hidden");
    $("compareFormat").textContent = data.formatLabel;
    $("compareViewTitle").textContent = data.rel.split(/[\\/]/).pop() ?? data.rel;

    syncFileSelect(data.rel);
    syncFormatSelect(data.format);
    syncModeSelect(state.compareMode);
    renderFacts(data, variant);
    renderLadder(data);

    $("compareErrors").innerHTML = data.errors.length
      ? data.errors.map((error) => `<p>${escapeHtml(error)}</p>`).join("")
      : "";

    // Hook up splitter dragging
    setupSplitterEvents(stage);

    // Hook up bottom dock events
    setupDockEvents();

    applyImageTransforms();

    const img = stage.querySelector<HTMLImageElement>(".compare-pane.original img");
    if (img) {
      if (img.complete && img.naturalWidth) {
        dimensions = { width: img.naturalWidth, height: img.naturalHeight };
        renderFacts(data, variant);
      } else {
        img.addEventListener("load", () => {
          if (img.naturalWidth && img.naturalHeight) {
            dimensions = { width: img.naturalWidth, height: img.naturalHeight };
            renderFacts(data, variant);
          }
        });
        img.addEventListener("error", () => {
          const p = document.createElement("p");
          p.textContent = "Failed to decode original image preview.";
          $("compareErrors").append(p);
        });
      }
    }
    const varImg = stage.querySelector<HTMLImageElement>(".compare-pane.variant img");
    varImg?.addEventListener("error", () => {
      const p = document.createElement("p");
      p.textContent = `Failed to decode ${data.formatLabel} q${variant.quality} preview.`;
      $("compareErrors").append(p);
    });
  };

  const updateSplitterPosition = (pct: number): void => {
    split = Math.max(2, Math.min(98, pct));
    const stage = $("compareStage");
    stage.style.setProperty("--split", `${split}%`);
    const line = stage.querySelector<HTMLElement>(".compare-split-line");
    if (line) line.style.left = `${split}%`;
    const handle = stage.querySelector<HTMLElement>(".compare-split-handle");
    if (handle) {
      handle.style.left = `${split}%`;
      handle.setAttribute("aria-valuenow", String(Math.round(split)));
    }
    const variantPane = stage.querySelector<HTMLElement>(".compare-pane.variant");
    if (variantPane) {
      const clip = `inset(0 0 0 ${split}%)`;
      variantPane.style.setProperty("-webkit-clip-path", clip);
      variantPane.style.clipPath = clip;
    }
  };

  const setupSplitterEvents = (stage: HTMLElement): void => {
    const onPointerMove = (e: PointerEvent) => {
      if (!isDraggingSplitter || state.compareMode !== "split") return;
      const rect = stage.getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      updateSplitterPosition(pct);
    };

    const onPointerUp = (e: PointerEvent) => {
      const handle = stage.querySelector<HTMLElement>(".compare-split-handle");
      if (isDraggingSplitter) {
        isDraggingSplitter = false;
        handle?.classList.remove("is-dragging");
        try {
          handle?.releasePointerCapture(e.pointerId);
        } catch {
          // ignore
        }
      }
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };

    const handle = stage.querySelector<HTMLElement>(".compare-split-handle");
    handle?.addEventListener("pointerdown", (e: PointerEvent) => {
      if (state.compareMode !== "split") return;
      e.preventDefault();
      e.stopPropagation();
      isDraggingSplitter = true;
      handle.classList.add("is-dragging");
      try {
        handle.setPointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
    });

    // The stage element is persistent while its innerHTML is replaced. Bind the
    // canvas listener once so re-renders cannot stack duplicate handlers.
    if (!stagePointerBound) {
      stagePointerBound = true;

      stage.addEventListener(
        "wheel",
        (e: WheelEvent) => {
          e.preventDefault();
          if (e.deltaY < 0) {
            setZoom(state.compareZoom === 0 ? 1 : Math.min(3, Number((state.compareZoom + 0.15).toFixed(2))));
          } else if (e.deltaY > 0) {
            setZoom(state.compareZoom <= 0.2 ? 0 : Math.max(0, Number((state.compareZoom - 0.15).toFixed(2))));
          }
        },
        { passive: false },
      );

      stage.addEventListener("pointerdown", (e: PointerEvent) => {
        if ((e.target as HTMLElement).closest(".canvas-dock, .frosted-badge, .compare-split-handle")) {
          return;
        }

        if (state.compareZoom > 0) {
          isPanning = true;
          const startX = e.clientX;
          const startY = e.clientY;
          const origPanX = panX;
          const origPanY = panY;
          stage.style.cursor = "grabbing";

          const onPanMove = (me: PointerEvent) => {
            if (!isPanning) return;
            panX = origPanX + (me.clientX - startX);
            panY = origPanY + (me.clientY - startY);
            applyImageTransforms();
          };

          const onPanUp = () => {
            isPanning = false;
            stage.style.cursor = "";
            window.removeEventListener("pointermove", onPanMove);
            window.removeEventListener("pointerup", onPanUp);
            window.removeEventListener("pointercancel", onPanUp);
          };

          window.addEventListener("pointermove", onPanMove);
          window.addEventListener("pointerup", onPanUp);
          window.addEventListener("pointercancel", onPanUp);
          return;
        }

        if (state.compareMode === "toggle") {
          state.compareShowOriginal = !state.compareShowOriginal;
          renderStage();
          return;
        }
        if (state.compareMode === "split") {
          const rect = stage.getBoundingClientRect();
          const pct = ((e.clientX - rect.left) / rect.width) * 100;
          updateSplitterPosition(pct);
          isDraggingSplitter = true;
          stage.querySelector<HTMLElement>(".compare-split-handle")?.classList.add("is-dragging");
          window.addEventListener("pointermove", onPointerMove);
          window.addEventListener("pointerup", onPointerUp);
          window.addEventListener("pointercancel", onPointerUp);
        }
      });
    }
  };

  const setupDockEvents = (): void => {
    const btnFit = document.getElementById("btnDockFit");
    btnFit?.addEventListener("click", () => setZoom(0));

    const btn100 = document.getElementById("btnDock100");
    btn100?.addEventListener("click", () => setZoom(1));

    const timeSlider = document.getElementById("compareTimeSlider") as HTMLInputElement | null;
    const timeOut = document.getElementById("compareTimeOut");
    timeSlider?.addEventListener("input", () => {
      if (timeOut) timeOut.textContent = fmtTime(Number(timeSlider.value));
    });
    timeSlider?.addEventListener("change", () => {
      if (state.compareRel) {
        void run(state.compareRel, activeFormat, Number(timeSlider.value));
      }
    });

    const dockGroup = document.getElementById("dockModeGroup");
    dockGroup?.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-dock-mode]");
      if (btn?.dataset.dockMode) {
        setMode(btn.dataset.dockMode as "split" | "side" | "toggle");
      }
    });

    const bgSelect = document.getElementById("compareBgSelect") as HTMLSelectElement | null;
    bgSelect?.addEventListener("change", () => {
      compareBg = (bgSelect.value as "checker" | "dark" | "light") || "checker";
      $("compareStage").dataset.bg = compareBg;
    });

    const btnFs = document.getElementById("btnDockFullscreen");
    btnFs?.addEventListener("click", () => {
      const screen = $("viewCompare");
      if (!document.fullscreenElement) {
        void screen.requestFullscreen().catch(() => {});
      } else {
        void document.exitFullscreen().catch(() => {});
      }
    });
  };

  const renderEmpty = (title: string, note: string): void => {
    $("compareEmpty").innerHTML = emptyState("compare", title, note);
    $("compareEmpty").classList.remove("hidden");
    $("compareStage").classList.add("hidden");
    $("compareRail").classList.add("hidden");
  };

  const run = async (
    rel: string,
    format?: OutputFormat,
    timestampSec?: number,
  ): Promise<void> => {
    const seq = ++activeRunSeq;
    compareAbort?.abort();
    const controller = new AbortController();
    compareAbort = controller;
    state.compareRel = rel;
    if (format) activeFormat = format;
    dimensions = null;
    state.compareVariant = 0;
    panX = 0;
    panY = 0;
    $("compareEmpty").innerHTML = `
      <div class="empty-state">
        <svg width="24" height="24" aria-hidden="true"><use href="#i-loader"></use></svg>
        <p class="empty-title">Encoding variants…</p>
        <p class="empty-note">${escapeHtml(rel)}</p>
      </div>
    `;
    $("compareEmpty").classList.remove("hidden");
    $("compareStage").classList.add("hidden");
    $("compareRail").classList.add("hidden");

    try {
      const baseNative = ["jpg", "jpeg", "jpe", "jfif", "png", "gif", "bmp", "webp"];
      const nativeFormats = (await canDecodeAvif()) ? [...baseNative, "avif"] : baseNative;
      if (seq !== activeRunSeq || controller.signal.aborted) return;
      const data = await actions.runCompare(rel, activeFormat, timestampSec, {
        signal: controller.signal,
        nativeFormats,
      });
      if (seq !== activeRunSeq || controller.signal.aborted) return;
      state.compare = data;
      if (!data.variants.length) {
        renderEmpty(
          "No variants produced",
          data.errors[0] ?? "The encoder returned no output for this file.",
        );
        return;
      }
      renderStage();
    } catch (error) {
      if (seq !== activeRunSeq || controller.signal.aborted || (error as Error)?.name === "AbortError") return;
      state.compare = null;
      renderEmpty("Could not compare this file", (error as Error).message);
    } finally {
      if (compareAbort === controller) compareAbort = null;
    }
  };

  const open = (rel?: string): void => {
    actions.switchView("compare");
    activeFormat = state.currentFormat;
    panX = 0;
    panY = 0;
    fileSelectCache = null; // rebuild against the selection the view opens with
    const files = fileList();
    const wanted = rel ?? state.compareRel;
    const chosen =
      rel ??
      (wanted && files.some((f) => f.rel === wanted) ? wanted : files[0]?.rel);
    if (!chosen) {
      renderEmpty(
        "No selected files to compare",
        "Select at least one image in the Library, then open Compare again.",
      );
      $("compareViewTitle").textContent = "Compare";
      $("compareFormat").textContent = state.formatSpecs[state.currentFormat]?.shortLabel ?? "—";
      return;
    }
    syncFileSelect(chosen);
    syncFormatSelect(activeFormat);
    const zoomSlider = document.getElementById("compareZoomSlider") as HTMLInputElement | null;
    if (zoomSlider) {
      const displayVal = Math.round(state.compareZoom * 100);
      zoomSlider.value = String(displayVal);
      const pct = (Number(zoomSlider.value) / Number(zoomSlider.max || 300)) * 100;
      zoomSlider.style.setProperty("--zoom-fill", `${pct}%`);
    }
    $("compareZoom").textContent =
      state.compareZoom > 0 ? `${Math.round(state.compareZoom * 100)}%` : "Fit";
    void run(chosen, activeFormat);
  };

  const close = (): void => {
    activeRunSeq++;
    compareAbort?.abort();
    compareAbort = null;
    actions.switchView("workspace");
  };

  const setMode = (mode: "split" | "side" | "toggle"): void => {
    state.compareMode = mode;
    if (mode === "toggle") state.compareShowOriginal = true;
    syncModeSelect(mode);
    renderStage();
  };

  const setZoom = (next: number): void => {
    state.compareZoom = Math.max(0, Math.min(3, next));
    if (state.compareZoom === 0) {
      panX = 0;
      panY = 0;
    }
    const slider = document.getElementById("compareZoomSlider") as HTMLInputElement | null;
    if (slider) {
      const displayVal = Math.round(state.compareZoom * 100);
      slider.value = String(displayVal);
      const pct = (displayVal / Number(slider.max || 300)) * 100;
      slider.style.setProperty("--zoom-fill", `${pct}%`);
    }
    $("compareZoom").textContent =
      state.compareZoom > 0 ? `${Math.round(state.compareZoom * 100)}%` : "Fit";
    const stage = $("compareStage");
    const imgs = stage.querySelectorAll<HTMLImageElement>(".compare-pane img");
    if (imgs.length) {
      applyImageTransforms();
      document.getElementById("btnDockFit")?.classList.toggle("active", state.compareZoom === 0);
      document.getElementById("btnDock100")?.classList.toggle("active", state.compareZoom === 1);
    } else {
      renderStage();
    }
  };

  const zoomIn = (): void =>
    setZoom(state.compareZoom === 0 ? 1 : Math.min(3, state.compareZoom + 0.25));
  const zoomOut = (): void =>
    setZoom(state.compareZoom <= 0.25 ? 0 : Math.max(0, state.compareZoom - 0.25));

  // Mode event listeners
  const modeSelect = document.getElementById("compareModeSelect") as HTMLSelectElement | null;
  modeSelect?.addEventListener("change", () => {
    const val = modeSelect.value as "split" | "side" | "toggle";
    if (val) setMode(val);
  });

  $("compareModes").addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-mode]");
    if (button?.dataset.mode) setMode(button.dataset.mode as "split" | "side" | "toggle");
  });

  // Zoom slider event listeners
  const zoomSlider = document.getElementById("compareZoomSlider") as HTMLInputElement | null;
  if (zoomSlider) {
    const initialPct = (Number(zoomSlider.value || 0) / Number(zoomSlider.max || 300)) * 100;
    zoomSlider.style.setProperty("--zoom-fill", `${initialPct}%`);
  }
  zoomSlider?.addEventListener("input", () => {
    const val = Number(zoomSlider.value);
    const pct = (val / Number(zoomSlider.max || 300)) * 100;
    zoomSlider.style.setProperty("--zoom-fill", `${pct}%`);
    setZoom(val === 0 ? 0 : val / 100);
  });

  $("compareZoomIn").addEventListener("click", zoomIn);
  $("compareZoomOut").addEventListener("click", zoomOut);
  $("compareClose").addEventListener("click", close);

  // File select change
  $("compareFileSelect").addEventListener("change", () => {
    const value = $<HTMLSelectElement>("compareFileSelect").value;
    if (value) void run(value, activeFormat);
  });

  // Format select change
  const formatSelect = document.getElementById("compareFormatSelect") as HTMLSelectElement | null;
  formatSelect?.addEventListener("change", () => {
    const chosenFormat = formatSelect.value as OutputFormat;
    if (chosenFormat && state.compareRel) {
      activeFormat = chosenFormat;
      void run(state.compareRel, chosenFormat);
    }
  });

  // Ladder card selection
  $("compareLadder").addEventListener("click", (event) => {
    const card = (event.target as HTMLElement).closest<HTMLElement>(".ladder-card");
    if (!card) return;
    const index = Number(card.dataset.variantIndex);
    if (!Number.isFinite(index) || !state.compare) return;
    state.compareVariant = index;
    renderStage();
  });

  // Bottom action buttons
  const applyBtn = document.getElementById("btnCompareApply");
  applyBtn?.addEventListener("click", () => {
    if (!state.compare) return;
    const variant = state.compare.variants[state.compareVariant];
    if (!variant) return;
    actions.setQuality(variant.quality, state.compare.format);
    const fmtName = state.compare.format.toUpperCase();
    actions.toast(`Quality set to q${variant.quality} for ${fmtName}.`, "success");
  });

  const setDefaultBtn = document.getElementById("btnCompareSetDefault");
  setDefaultBtn?.addEventListener("click", () => {
    if (!state.compare) return;
    const variant = state.compare.variants[state.compareVariant];
    if (!variant) return;
    actions.setQuality(variant.quality, state.compare.format);
    const fmtName = state.compare.format.toUpperCase();
    actions.toast(`q${variant.quality} set as default for ${fmtName}.`, "success");
  });

  const handleKey = (event: KeyboardEvent): boolean => {
    if (state.view !== "compare") return false;
    const tag = (event.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return false;

    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return true;
    }
    if (event.key === " ") {
      event.preventDefault();
      state.compareShowOriginal = !state.compareShowOriginal;
      renderStage();
      return true;
    }
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoomIn();
      return true;
    }
    if (event.key === "-") {
      event.preventDefault();
      zoomOut();
      return true;
    }
    if (event.key === "0") {
      event.preventDefault();
      setZoom(0);
      return true;
    }
    if (event.key === "1") {
      event.preventDefault();
      setZoom(1);
      return true;
    }
    if ((event.key === "[" || event.key === "]") && state.compare?.variants.length) {
      event.preventDefault();
      const count = state.compare.variants.length;
      const step = event.key === "]" ? 1 : -1;
      state.compareVariant = (state.compareVariant + step + count) % count;
      renderStage();
      return true;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const files = fileList();
      if (files.length <= 1) return true;
      const idx = files.findIndex((f) => f.rel === state.compareRel);
      const step = event.key === "ArrowRight" ? 1 : -1;
      const nextIdx = (idx + step + files.length) % files.length;
      const nextRel = files[nextIdx].rel;
      void run(nextRel, activeFormat);
      return true;
    }
    return false;
  };

  $("compareZoom").textContent = "Fit";
  return { open, close, handleKey };
}
