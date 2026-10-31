/**
 * Library pane: source card, filter, and the include/exclude tree.
 *
 * Selection rules live in tree-logic.ts. This module owns only the DOM: it
 * rebuilds lazily, keeps open folders and scroll position across redraws, and
 * never mutates the tree it was given.
 */
import { $, escapeHtml, fmt, icon, input, type ToastKind } from "./dom";
import { state } from "./state";
import * as treeLogic from "./tree-logic";
import type { ScanResult, ScannedFile, TreeNode } from "./types";

export type LibraryOptions = {
  onChange: () => void;
  onPreview: () => void;
  onToast: (message: string, kind?: ToastKind) => void;
  onOpenLightbox?: (rel: string, getVisibleFiles: () => ScannedFile[]) => void;
};

export type LibraryController = {
  setScan: (scan: ScanResult, reset: boolean) => void;
  refresh: () => void;
  selected: () => ScannedFile[];
  selectedBytes: () => number;
  focus: () => void;
  resetSelection: () => void;
  allFiles: () => ScannedFile[];
};

const DISPLAYABLE = new Set(["jpg", "jpeg", "png", "gif", "webp", "avif", "bmp"]);

const byName = (a: { name: string }, b: { name: string }): number =>
  a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

const flatten = (node: TreeNode): ScannedFile[] => [
  ...node.files,
  ...node.children.flatMap(flatten),
];

export function createLibrary(opts: LibraryOptions): LibraryController {
  const box = $("tree");
  const filterInput = input("treeFilter");
  const clearFilter = $("btnClearFilter");

  const pathOptions = () => ({
    sep: state.status?.pathSeparator ?? "\\",
    caseInsensitive: state.status?.caseInsensitive ?? true,
  });

  const fold = (value: string): string =>
    (state.status?.caseInsensitive ?? true) ? value.toLowerCase() : value;

  const allFiles = (): ScannedFile[] => {
    if (!state.tree) return [];
    const list = flatten(state.tree);
    return state.mediaMode === "video"
      ? list.filter((f) => f.category === "video")
      : list.filter((f) => f.category === "image" || f.category === "raw");
  };

  const selected = (): ScannedFile[] => {
    if (!state.tree) return [];
    const o = pathOptions();
    const ci = o.caseInsensitive;
    const ex = treeLogic.excludedLower(state.excluded, ci);
    const inc = treeLogic.excludedLower(state.included, ci);
    const exFiles = treeLogic.excludedLower(state.excludedFiles, ci);
    const incFiles = treeLogic.excludedLower(state.includedFiles, ci);
    return allFiles().filter((file) =>
      !treeLogic.isFileExcluded(file.rel, ex, inc, exFiles, incFiles, o));
  };

  const selectedBytes = (): number => selected().reduce((sum, file) => sum + file.size, 0);

  const prune = (): void => {
    if (!state.tree) return;
    const folders = new Set(treeLogic.collectRels(state.tree).map(fold));
    const files = new Set(allFiles().map((file) => fold(file.rel)));
    state.excluded = new Set([...state.excluded].filter((rel) => folders.has(fold(rel))));
    state.included = new Set([...state.included].filter((rel) => folders.has(fold(rel))));
    state.excludedFiles = new Set([...state.excludedFiles].filter((rel) => files.has(fold(rel))));
    state.includedFiles = new Set([...state.includedFiles].filter((rel) => files.has(fold(rel))));
  };

  const nodeMatches = (node: TreeNode, query: string): boolean => {
    if (!query) return true;
    if (node.rel.toLowerCase().includes(query)) return true;
    if (node.files.some((file) => file.rel.toLowerCase().includes(query))) return true;
    return node.children.some((child) => nodeMatches(child, query));
  };

  const visibleFiles = (files: ScannedFile[], query: string, ancestorMatched: boolean): ScannedFile[] => {
    const isVideo = state.mediaMode === "video";
    const modeFiltered = isVideo
      ? files.filter((file) => file.category === "video")
      : files.filter((file) => file.category === "image" || file.category === "raw");
    const list = !query || ancestorMatched
      ? modeFiltered
      : modeFiltered.filter((file) => file.rel.toLowerCase().includes(query));
    return [...list].sort(byName);
  };

  const thumb = (file: ScannedFile): HTMLElement => {
    const node = document.createElement("span");
    node.className = "tree-thumb clickable";
    node.tabIndex = 0;
    node.setAttribute("role", "button");
    node.setAttribute("aria-label", `Preview ${file.name}`);
    node.title = `Click to preview ${file.name}`;

    const ext = String(file.ext || "?").toUpperCase();
    const img = document.createElement("img");
    img.src = `/api/thumb?rel=${encodeURIComponent(file.rel)}`;
    img.alt = "";
    img.loading = "lazy";
    img.addEventListener("error", () => {
      img.remove();
      node.textContent = ext.slice(0, 4);
      node.classList.add("tree-ext");
      if (file.category === "raw") node.classList.add("raw");
      if (file.category === "video" || file.category === "other") node.classList.add("other");
    });
    node.append(img);

    const onOpen = (event: Event) => {
      event.stopPropagation();
      opts.onOpenLightbox?.(file.rel, allFiles);
    };

    node.addEventListener("click", onOpen);
    node.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onOpen(event);
      }
    });

    return node;
  };

  const fileRow = (file: ScannedFile, depth: number, ctx: SelectionContext): HTMLElement => {
    const row = document.createElement("div");
    row.className = "tree-row";
    row.dataset.rel = file.rel;
    row.dataset.kind = "file";
    row.style.paddingLeft = `${8 + depth * 14}px`;
    row.title = file.rel;

    const included = !treeLogic.isFileExcluded(
      file.rel, ctx.ex, ctx.inc, ctx.exFiles, ctx.incFiles, ctx.opts,
    );
    if (!included) row.classList.add("excluded");

    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "tree-check";
    check.checked = included;
    check.setAttribute("aria-label", `Include ${file.name}`);
    check.addEventListener("change", () => setFileSelected(file, check.checked));

    const spacer = document.createElement("span");
    spacer.className = "tree-caret leaf";

    const name = document.createElement("button");
    name.type = "button";
    name.className = "tree-name";
    name.textContent = file.name;
    name.title = file.rel;
    name.addEventListener("click", () => {
      check.checked = !check.checked;
      setFileSelected(file, check.checked);
    });

    const size = document.createElement("span");
    size.className = "tree-size";
    size.textContent = fmt(file.size);

    const text = document.createElement("span");
    text.className = "tree-file-text";
    text.append(name, size);

    const pills = document.createElement("span");
    pills.className = "tree-pills";
    const keep = document.createElement("button");
    keep.type = "button";
    keep.className = "tree-pill" + (included ? " on" : "");
    keep.textContent = "Keep";
    keep.title = "Include this file in the conversion plan";
    keep.setAttribute("aria-pressed", String(included));
    keep.addEventListener("click", (event) => {
      event.stopPropagation();
      if (!check.checked) {
        check.checked = true;
        setFileSelected(file, true);
      }
    });
    const skip = document.createElement("button");
    skip.type = "button";
    skip.className = "tree-pill" + (included ? "" : " on");
    skip.textContent = "Skip";
    skip.title = "Leave this file out of the conversion plan";
    skip.setAttribute("aria-pressed", String(!included));
    skip.addEventListener("click", (event) => {
      event.stopPropagation();
      if (check.checked) {
        check.checked = false;
        setFileSelected(file, false);
      }
    });
    pills.append(keep, skip);

    row.append(check, spacer, thumb(file), text, pills);

    if (file.category === "raw") {
      const badge = document.createElement("span");
      badge.className = "tree-badge raw";
      badge.textContent = "RAW";
      row.append(badge);
    } else if (file.category === "other") {
      const badge = document.createElement("span");
      badge.className = "tree-badge dead";
      badge.textContent = file.category;
      badge.title = "Not an image format; this file is always skipped.";
      row.append(badge);
    }
    return row;
  };

  const FILE_CHUNK_SIZE = 150;

  const scrollRoot = box.closest(".library-scroll") as HTMLElement | null;
  const chunkObserver =
    "IntersectionObserver" in window
      ? new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (!entry.isIntersecting) continue;
              const sentinel = entry.target as HTMLElement & { _loadMore?: () => void };
              sentinel._loadMore?.();
            }
          },
          { root: scrollRoot, rootMargin: "240px 0px" },
        )
      : null;

  /**
   * Append file rows in batches so expanding a 5,000-photo folder stays fast.
   * A sentinel at the end of the batch loads the next 150 rows when it scrolls
   * into view; clicking it works too for keyboard users and when the observer
   * is unavailable.
   */
  const appendFilesChunked = (
    container: HTMLElement,
    files: ScannedFile[],
    depth: number,
    ctx: SelectionContext,
  ): void => {
    let offset = 0;

    const renderNextBatch = (): void => {
      const slice = files.slice(offset, offset + FILE_CHUNK_SIZE);
      offset += slice.length;
      const frag = document.createDocumentFragment();
      for (const file of slice) {
        frag.append(fileRow(file, depth, ctx));
      }
      container.append(frag);

      if (offset < files.length) {
        const remaining = files.length - offset;
        const sentinel = document.createElement("button") as HTMLButtonElement & {
          _loadMore?: () => void;
        };
        sentinel.type = "button";
        sentinel.className = "tree-row muted";
        sentinel.style.paddingLeft = `${8 + depth * 14}px`;
        sentinel.textContent = `Show ${Math.min(FILE_CHUNK_SIZE, remaining).toLocaleString()} more (${remaining.toLocaleString()} remaining)…`;

        const trigger = (): void => {
          chunkObserver?.unobserve(sentinel);
          sentinel.remove();
          renderNextBatch();
        };
        sentinel._loadMore = trigger;
        sentinel.addEventListener("click", trigger, { once: true });
        container.append(sentinel);
        chunkObserver?.observe(sentinel);
      }
    };

    renderNextBatch();
  };

  type SelectionContext = {
    opts: { sep: string; caseInsensitive: boolean };
    ex: ReadonlySet<string>;
    inc: ReadonlySet<string>;
    exFiles: ReadonlySet<string>;
    incFiles: ReadonlySet<string>;
    q: string;
    counts: Map<string, treeLogic.SelectionCount>;
  };

  const context = (): SelectionContext => {
    const o = pathOptions();
    const ci = o.caseInsensitive;
    return {
      opts: o,
      ex: treeLogic.excludedLower(state.excluded, ci),
      inc: treeLogic.excludedLower(state.included, ci),
      exFiles: treeLogic.excludedLower(state.excludedFiles, ci),
      incFiles: treeLogic.excludedLower(state.includedFiles, ci),
      q: state.filterQuery.trim().toLowerCase(),
      counts: new Map(),
    };
  };

  const nodeElement = (
    node: TreeNode,
    ctx: SelectionContext,
    ancestorMatched = false,
  ): HTMLElement | null => {
    const selfMatch = !ctx.q || ancestorMatched || node.rel.toLowerCase().includes(ctx.q);
    if (ctx.q && !selfMatch && !nodeMatches(node, ctx.q)) return null;

    const stats = ctx.counts.get(node.rel) ?? { total: 0, selected: 0 };
    const fully = treeLogic.isFullyExcluded(node.rel, ctx.ex, ctx.inc, ctx.opts);
    let checked: boolean;
    let indeterminate = false;
    if (stats.total > 0) {
      checked = stats.selected === stats.total;
      indeterminate = stats.selected > 0 && stats.selected < stats.total;
    } else {
      checked = !fully;
      indeterminate = !fully && treeLogic.hasExcludedDescendant(node, ctx.ex, ctx.inc, ctx.opts);
    }

    const wrap = document.createElement("div");
    const hasKids = node.children.length > 0 || node.files.length > 0;
    const isOpen = ctx.q ? true : state.expanded.has(node.rel);

    const row = document.createElement("div");
    row.className = "tree-row";
    if (stats.total > 0 ? stats.selected === 0 : fully) row.classList.add("excluded");
    row.dataset.rel = node.rel;
    row.dataset.kind = "folder";
    row.style.paddingLeft = `${8 + node.depth * 14}px`;

    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "tree-check";
    check.checked = checked;
    check.indeterminate = indeterminate;
    check.setAttribute("aria-label", `Include ${node.name} and everything in it`);
    check.addEventListener("click", (event) => event.stopPropagation());
    check.addEventListener("change", () => setExcluded(node.rel, !check.checked));

    const caret = document.createElement("button");
    caret.type = "button";
    caret.className = "tree-caret" + (hasKids ? "" : " leaf");
    caret.setAttribute("aria-expanded", isOpen ? "true" : "false");
    caret.setAttribute("aria-label", isOpen ? `Collapse ${node.name}` : `Expand ${node.name}`);
    caret.innerHTML = hasKids ? icon("chevron-right", 11) : "";

    const folder = document.createElement("span");
    folder.className = "tree-thumb";
    folder.innerHTML = icon("folder", 14);

    const name = document.createElement("button");
    name.type = "button";
    name.className = "tree-name";
    name.textContent = node.name;
    name.title = node.rel;
    if (hasKids) name.setAttribute("aria-expanded", isOpen ? "true" : "false");

    const isVideoMode = state.mediaMode === "video";
    const folderCount = isVideoMode ? node.videoCount : node.imageCount + node.rawCount;
    const folderBytes = isVideoMode ? node.videoBytes : node.imageBytes + node.rawBytes;

    if (folderCount === 0 && !ctx.q) return null;

    const count = document.createElement("span");
    count.className = "tree-count";
    count.textContent = folderCount.toLocaleString();
    count.title = `${folderCount.toLocaleString()} ${isVideoMode ? "videos" : "photos"} in this folder and below`;

    const size = document.createElement("span");
    size.className = "tree-size";
    size.textContent = fmt(folderBytes);

    row.append(check, caret, folder, name);
    if (folderCount > 0) row.append(count);
    row.append(size);

    if (!isVideoMode && node.rawBytes > 0) {
      const badge = document.createElement("span");
      badge.className = "tree-badge raw";
      badge.textContent = `RAW ${fmt(node.rawBytes)}`;
      row.append(badge);
    }
    const nothingConvertible = isVideoMode
      ? node.videoCount === 0
      : node.imageCount + node.rawCount === 0;
    if (nothingConvertible) {
      const badge = document.createElement("span");
      badge.className = "tree-badge dead";
      badge.textContent = isVideoMode ? "no videos" : "nothing convertible";
      badge.title = isVideoMode
        ? "No video files found in this folder or its subfolders."
        : `${node.otherCount} other files, ${fmt(node.otherBytes)} (junk, video or cache)`;
      row.append(badge);
    }

    const kids = document.createElement("div");
    kids.className = "tree-kids" + (isOpen ? " open" : "");

    let built = false;
    const buildKids = (): void => {
      if (built) return;
      built = true;
      const filesToRender = visibleFiles(node.files, ctx.q, selfMatch);
      if (filesToRender.length) {
        // Keep chunked files above child folders even when later batches load.
        const fileHost = document.createElement("div");
        fileHost.style.display = "contents";
        kids.append(fileHost);
        appendFilesChunked(fileHost, filesToRender, node.depth + 1, ctx);
      }
      for (const child of [...node.children].sort(byName)) {
        const el = nodeElement(child, ctx, selfMatch);
        if (el) kids.append(el);
      }
    };

    const toggleOpen = (): void => {
      if (!hasKids) return;
      const open = !kids.classList.contains("open");
      if (open) buildKids();
      kids.classList.toggle("open", open);
      if (open) state.expanded.add(node.rel);
      else state.expanded.delete(node.rel);
      caret.setAttribute("aria-expanded", open ? "true" : "false");
      caret.setAttribute("aria-label", open ? `Collapse ${node.name}` : `Expand ${node.name}`);
      name.setAttribute("aria-expanded", open ? "true" : "false");
    };

    caret.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleOpen();
    });
    name.addEventListener("click", toggleOpen);

    wrap.append(row, kids);
    if (isOpen) buildKids();
    return wrap;
  };

  const render = (): void => {
    const focusedRel = document.activeElement?.closest<HTMLElement>("[data-rel]")?.dataset.rel ?? null;
    const scrollTop = box.scrollTop;
    chunkObserver?.disconnect();
    box.innerHTML = "";

    if (!state.tree) {
      box.innerHTML = `<div class="empty-state">
        <svg width="22" height="22" aria-hidden="true"><use href="#i-folder"></use></svg>
        <p class="empty-title">No library yet</p>
        <p class="empty-note">Pick a folder above, then press <b>Scan</b>.</p>
      </div>`;
      $("scanSummary").textContent = "not scanned";
      clearFilter.classList.add("hidden");
      $("treeFilterInfo").classList.add("hidden");
      return;
    }

    const ctx = context();
    treeLogic.countSelection(
      state.tree,
      (file) => !treeLogic.isFileExcluded(
        file.rel, ctx.ex, ctx.inc, ctx.exFiles, ctx.incFiles, ctx.opts,
      ),
      ctx.counts,
    );

    const rootFiles = visibleFiles(state.tree.files, ctx.q, false);
    if (rootFiles.length) {
      const label = document.createElement("div");
      label.className = "tree-group-label";
      label.textContent = "Files in source root";
      box.append(label);
      appendFilesChunked(box, rootFiles, 0, ctx);
    }

    for (const child of [...state.tree.children].sort(byName)) {
      const el = nodeElement(child, ctx, false);
      if (el) box.append(el);
    }

    if (!box.children.length) {
      box.innerHTML = `<div class="empty-state">
        <p class="empty-title">${ctx.q ? "No files match this filter" : "No files found"}</p>
        <p class="empty-note">${ctx.q ? "Try a shorter search." : "This folder has nothing to convert."}</p>
      </div>`;
    }

    const selectedInfo = ctx.counts.get(state.tree.rel) ?? { total: 0, selected: 0 };
    const scan = state.lastScan;
    const isVideo = state.mediaMode === "video";
    const modeCount = isVideo
      ? (scan?.totals.videoCount ?? 0)
      : ((scan?.totals.imageCount ?? 0) + (scan?.totals.rawCount ?? 0));
    const modeBytes = isVideo
      ? (scan?.totals.videoBytes ?? 0)
      : ((scan?.totals.imageBytes ?? 0) + (scan?.totals.rawBytes ?? 0));
    $("scanSummary").textContent = scan
      ? `${modeCount.toLocaleString()} ${isVideo ? "videos" : "photos"} · ${fmt(modeBytes)} · ${selectedInfo.selected.toLocaleString()} selected · ${(scan.durationMs / 1000).toFixed(1)}s`
      : `${selectedInfo.selected.toLocaleString()} selected`;

    clearFilter.classList.toggle("hidden", !filterInput.value);
    if (!ctx.q) {
      $("treeFilterInfo").classList.add("hidden");
      $("treeFilterInfo").textContent = "";
    } else {
      const matches = allFiles().filter((file) => file.rel.toLowerCase().includes(ctx.q)).length;
      $("treeFilterInfo").classList.remove("hidden");
      $("treeFilterInfo").textContent = `${matches.toLocaleString()} matching file${matches === 1 ? "" : "s"}`;
    }

    box.scrollTop = scrollTop;
    if (focusedRel) {
      box.querySelector<HTMLInputElement>(`[data-rel="${CSS.escape(focusedRel)}"] input`)?.focus();
    }
  };

  const notify = (preview = true): void => {
    opts.onChange();
    if (preview) opts.onPreview();
  };

  const setExcluded = (rel: string, exclude: boolean): void => {
    if (!state.tree) return;
    const result = treeLogic.toggleFolder(state.tree, state.excluded, rel, exclude, state.included, pathOptions());
    state.excluded = result.excluded;
    state.included = result.included;
    const files = treeLogic.clearFileOverridesUnder(rel, state.excludedFiles, state.includedFiles, pathOptions());
    state.excludedFiles = files.excludedFiles;
    state.includedFiles = files.includedFiles;
    if (exclude) state.expanded.add(rel);
    prune();
    render();
    notify();
  };

  const setFileSelected = (file: ScannedFile, select: boolean): void => {
    const result = treeLogic.toggleFile(
      file.rel, !select, state.excludedFiles, state.includedFiles, pathOptions(),
    );
    state.excludedFiles = result.excludedFiles;
    state.includedFiles = result.includedFiles;
    prune();
    render();
    notify();
  };

  const resetSelection = (): void => {
    state.excluded = new Set();
    state.included = new Set();
    state.excludedFiles = new Set();
    state.includedFiles = new Set();
  };

  const setScan = (scan: ScanResult, reset: boolean): void => {
    state.lastScan = scan;
    state.tree = scan.tree;
    if (reset) {
      resetSelection();
      state.expanded = new Set();
      state.filterQuery = "";
      filterInput.value = "";
    }
    prune();
    render();
    opts.onChange();
  };

  filterInput.addEventListener("input", () => {
    state.filterQuery = filterInput.value;
    box.scrollTop = 0;
    render();
  });

  filterInput.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    filterInput.value = "";
    state.filterQuery = "";
    box.scrollTop = 0;
    render();
  });

  clearFilter.addEventListener("click", () => {
    filterInput.value = "";
    state.filterQuery = "";
    filterInput.focus();
    render();
  });

  $("btnExpandAll").addEventListener("click", () => {
    if (!state.tree) return;
    state.expanded = new Set(treeLogic.collectRels(state.tree));
    render();
  });

  $("btnCollapseAll").addEventListener("click", () => {
    state.expanded = new Set();
    render();
  });

  $("btnAll").addEventListener("click", () => {
    if (!state.tree) return;
    resetSelection();
    render();
    notify();
  });

  $("btnNone").addEventListener("click", () => {
    if (!state.tree) return;
    state.excluded = new Set(treeLogic.topLevelRels(state.tree));
    state.included = new Set();
    state.excludedFiles = new Set(state.tree.files.map((file) => file.rel));
    state.includedFiles = new Set();
    render();
    notify();
  });

  const focus = (): void => {
    filterInput.focus();
    filterInput.select();
  };

  return {
    setScan,
    refresh: render,
    selected,
    selectedBytes,
    focus,
    resetSelection,
    allFiles,
  };
}
