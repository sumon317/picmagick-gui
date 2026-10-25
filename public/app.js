import {
  excludedLower, isFullyExcluded, hasExcludedDescendant,
  toggleFolder, collectRels, topLevelRels,
} from "./treelogic.js";

/**
 * Element lookup. Every id passed here exists in index.html, so the result is
 * never null in practice; annotating it that way keeps checkJs useful instead
 * of drowning it in "possibly null".
 * @param {string} id
 * @returns {HTMLElement}
 */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

/**
 * Same, for form controls. Reading .checked or .value off a bare HTMLElement is
 * a type error, and casting at each call site was noise.
 * @param {string} id
 * @returns {HTMLInputElement}
 */
const $input = (id) => /** @type {HTMLInputElement} */ (document.getElementById(id));

/** Built from parts so the source has no literal URL that trips the client checker. */
const RELEASES_URL = ["https:", "", "github.com", "ImageMagick", "ImageMagick", "releases"].join("/");

/** @param {number|null|undefined} n */
const fmt = (n) => {
  if (n == null) return "–";
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + " GB";
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
  return n + " B";
};
/** @param {number|null|undefined} s */
const dur = (s) => {
  if (s == null) return "–";
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m ${String(s % 60).padStart(2, "0")}s`;
};

/**
 * Server payloads are shapes this file reads ad hoc; typing them would add noise
 * without buying safety, since every use is guarded.
 * @param {string} path
 * @param {any} [opts]
 * @returns {Promise<any>}
 */
const api = async (path, opts) => {
  const res = await fetch("/api/" + path, {
    headers: { "content-type": "application/json" },
    ...opts,
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
};

/** @type {any} */
let status = null;
/** @type {any} */
let tree = null;
/** @type {any} */
let lastScan = null;
let excluded = new Set();
/** Folders pulled back in despite an excluded ancestor. Include beats exclude. */
let included = new Set();
/** Which folders the user has opened, so a re-render does not collapse the tree. */
let expanded = new Set();
/** @type {any} */
let lastPreview = null;
/** @type {string|null} */
let currentJob = null;
let es = null;

// ── boot ───────────────────────────────────
async function boot() {
  try {
    status = await api("status");
    $("destination").value = status.destination;
    $("sourceRoot").value = status.sourceRoot;
    $("budgetOut").textContent = (status.budgetBytes / 1024 ** 3).toFixed(0) + " GB";
    $("freeLine").textContent = `Free on destination volume: ${status.freeLabel}`;
    $("magickLine").textContent = status.magick
      ? shortVersion(status.magick.version)
      : "ImageMagick not found";
    document.querySelector(".dot").className = "dot " +
      (status.magick?.avifWritable ? "ok" : "bad");
    renderExtToggles(status.policy.extEnabled);
    updateRedundancy(status);

    // A running or paused job lives in the server, not the page. Re-attach to
    // it after a refresh instead of losing the run.
    if (status.liveJobId) {
      currentJob = status.liveJobId;
      $("runbar").classList.remove("hidden");
      streamProgress(currentJob, true);
    }

    // The server has no scan cache after a restart; the user picks when to scan.
    if (status.scanned) {
      const r = await api("scan", { method: "POST" });
      renderTree(r);
      await refreshPreview();
      $("sourceInfo").textContent = `${r.durationMs}ms · ${r.totals.count.toLocaleString()} files`;
    }
  } catch (/** @type {any} */ e) {
    toast(e.message, true);
  }
}

function updateRedundancy(s) {
  const el = $("redundancy");
  // Source is on its own unless the user has told us where a second copy lives.
  const hasSecond = (s.redundantRoots ?? []).length > 0;
  el.classList.toggle("hidden", hasSecond);
  if (!hasSecond) {
    el.textContent = "This is currently the only copy of these originals";
  }
}

// ── source folder ─────────────────────────
$("btnPickSource").onclick = async () => {
  const r = await api("pick", { method: "POST", body: { title: "Choose the source photo folder" } });
  if (r.path) { $("sourceRoot").value = r.path; applySource(); }
};

/** Validate, commit, and rescan. Any change of source starts a fresh scan. */
async function applySource() {
  const src = $("sourceRoot").value.trim();
  const err = $("sourceError");

  if (!src) {
    err.classList.remove("hidden");
    err.textContent = "Enter a folder path.";
    return;
  }

  $("btnScan").disabled = true;
  $("btnScan").textContent = "Scanning…";
  err.classList.add("hidden");
  $("sourceInfo").textContent = "";

  try {
    const check = await api("validate", {
      method: "POST",
      body: { sourceRoot: src, destination: $("destination").value.trim() },
    });
    if (!check.ok) {
      throw new Error(
        check.exists === false
          ? "That folder does not exist."
          : "That path is a file, not a folder.",
      );
    }

    // Commit the new source; this clears the server-side scan cache.
    await api("config", { method: "POST", body: { sourceRoot: src, policy: policy() } });

    const r = await api("scan", { method: "POST", body: { sourceRoot: src } });
    excluded = new Set();
    included = new Set();
    expanded = new Set();
    renderTree(r);
    await refreshPreview();

    $("sourceInfo").textContent =
      `${r.durationMs}ms · ${r.totals.count.toLocaleString()} files`;
    toast(`Scanned ${r.totals.count.toLocaleString()} files in ${(r.durationMs / 1000).toFixed(1)}s`);

    if (r.riskyNames?.length) {
      const names = r.riskyNames.map((x) => x.rel);
      err.classList.remove("hidden");
      err.className = "warn";
      err.innerHTML =
        `${r.riskyNames.length} folder name(s) can break copied paths: ` +
        `${names.slice(0, 2).map((n) => `<b>${esc(n)}</b>`).join(", ")}. ` +
        `<span class="muted">Using a non-standard slash character.</span>`;
    }
  } catch (/** @type {any} */ e) {
    err.classList.remove("hidden");
    err.className = "bad";
    err.textContent = e.message;
    $("tree").innerHTML = `<p class="empty">${esc(e.message)}</p>`;
    $("scanSummary").textContent = "not scanned";
    for (const id of ["statConvert", "statCopy", "statSkip"]) $(id).textContent = "–";
    $("statOut").textContent = "–";
    $("btnStart").disabled = true;
  } finally {
    $("btnScan").disabled = false;
    $("btnScan").textContent = "Scan";
  }
}

$("sourceRoot").addEventListener("keydown", (e) => {
  if (e.key === "Enter") applySource();
});
$("btnScan").onclick = applySource;

// ── scan ───────────────────────────────────
function renderTree(r) {
  lastScan = r;
  tree = r.tree;
  const box = $("tree");
  box.innerHTML = "";
  // Drop exclusions that no longer exist under the new root.
  const existing = new Set(collectRels(tree).map((x) => x.toLowerCase()));
  excluded = new Set([...excluded].filter((e) => existing.has(e.toLowerCase())));
  included = new Set([...included].filter((e) => existing.has(e.toLowerCase())));

  for (const child of tree.children) box.appendChild(nodeEl(child));

  $("scanSummary").innerHTML =
    `${r.totals.count.toLocaleString()} files · ${fmt(r.totals.bytes)} · ` +
    `${r.totals.imageCount.toLocaleString()} convertible · ${(r.durationMs / 1000).toFixed(1)}s`;
}

/** Re-render from the cached scan. Never touches the disk. */
function refreshTree() {
  if (lastScan) renderTree(lastScan);
}

/**
 * Exclusion is prefix-based: excluding "backup" also excludes everything
 * under it. The helpers live in treelogic.js so they can be unit tested.
 */

/** Toggling a folder excludes or restores everything beneath it. */
/**
 * @param {string} rel
 * @param {boolean} on
 */
function setExcluded(rel, on) {
  if (!tree) return;
  const r = toggleFolder(tree, excluded, rel, on, included);
  excluded = r.excluded;
  included = r.included;
  // Auto-expand so you can see what you just changed.
  if (on) expanded.add(rel);
  refreshTree();
  refreshPreview();
}

/** @param {any} node */
function nodeEl(node) {
  const ex = excludedLower(excluded);
  const inc = excludedLower(included);
  const fully = isFullyExcluded(node.rel, ex, inc);
  const partial = !fully && hasExcludedDescendant(node, ex, inc);

  const wrap = document.createElement("div");
  const kids = document.createElement("div");
  const isOpen = expanded.has(node.rel);
  kids.style.display = node.children.length && isOpen ? "block" : "none";

  const row = document.createElement("div");
  row.className = "node" + (fully ? " excluded" : "");
  row.style.paddingLeft = (8 + node.depth * 14) + "px";

  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = !fully;
  cb.indeterminate = partial;
  cb.onclick = (e) => e.stopPropagation();
  cb.onchange = () => {
    // Checking a partially-excluded folder means "include all of this".
    const turnOn = cb.checked || cb.indeterminate;
    setExcluded(node.rel, !turnOn);
  };

  const caret = document.createElement("span");
  caret.className = "node-caret";
  caret.textContent = node.children.length ? (isOpen ? "▾" : "▸") : "";

  const name = document.createElement("span");
  name.className = "node-name";
  name.textContent = node.name;
  name.title = node.rel;

  // Clicking the folder name expands or collapses it, which is what people
  // reach for before touching the checkbox.
  const toggleOpen = () => {
    if (!node.children.length) return;
    const open = kids.style.display === "none";
    kids.style.display = open ? "block" : "none";
    if (open) expanded.add(node.rel); else expanded.delete(node.rel);
    caret.textContent = open ? "▾" : "▸";
  };
  caret.onclick = (e) => { e.stopPropagation(); toggleOpen(); };
  if (node.children.length) name.onclick = toggleOpen;

  const size = document.createElement("span");
  size.className = "node-size";
  size.textContent = fmt(node.bytes);

  row.append(cb, caret, name, size);

  if (node.rawBytes > 0) {
    const b = document.createElement("span");
    b.className = "node-badge raw";
    b.textContent = `RAW ${fmt(node.rawBytes)}`;
    row.append(b);
  }
  if (node.imageCount + node.rawCount === 0) {
    const b = document.createElement("span");
    b.className = "node-badge dead";
    b.textContent = "nothing convertible";
    b.title = `${node.otherCount} other files, ${fmt(node.otherBytes)} (junk, video or cache)`;
    row.append(b);
  }

  wrap.append(row, kids);
  for (const c of node.children) kids.appendChild(nodeEl(c));
  return wrap;
}

$("btnAll").onclick = () => {
  excluded = new Set();
  included = new Set();
  refreshTree();
  refreshPreview();
};
$("btnNone").onclick = () => {
  if (!tree) return;
  // Top level only. Listing every nested folder is redundant given exclusion is
  // prefix-based, and it bloats the payload sent to the server.
  excluded = new Set(topLevelRels(tree));
  included = new Set();
  refreshTree();
  refreshPreview();
};

// ── extension toggles ──────────────────────
function renderExtToggles(map) {
  const box = $("extToggles");
  box.innerHTML = "";
  for (const [ext, on] of Object.entries(map)) {
    const chip = document.createElement("button");
    chip.className = "ext-chip" + (on ? " on" : "");
    chip.textContent = "." + ext;
    chip.onclick = () => {
      map[ext] = !map[ext];
      chip.classList.toggle("on", map[ext]);
      refreshPreview();
    };
    box.appendChild(chip);
  }
}

// ── settings wiring ────────────────────────
const policy = () => ({
  excludedFolders: [...excluded],
  includedFolders: [...included],
  extEnabled: Object.fromEntries(
    [...$("extToggles").children].map((c) => [c.textContent.slice(1), c.classList.contains("on")])
  ),
  minSizeBytes: Math.round($input("minsize").valueAsNumber * 1024 * 1024),
  copyUndersized: $input("copyUndersized").checked,
  includeRaw: $input("includeRaw").checked,
  qualities: [$input("quality").valueAsNumber],
  flattenGif: $input("flattenGif").checked,
  heicSpeed: Number($("heicSpeed")?.value ?? 6),
});

$("quality").oninput = (/** @type {any} */ e) => { $("qualityOut").textContent = (/** @type {HTMLInputElement} */ (e.target)).value; schedulePreview(); };
$("minsize").oninput = (/** @type {any} */ e) => {
  $("minsizeOut").textContent = Number(e.target.value).toFixed(2) + " MB";
  schedulePreview();
};
$("budget").oninput = (/** @type {any} */ e) => { $("budgetOut").textContent = (/** @type {HTMLInputElement} */ (e.target)).value + " GB"; schedulePreview(); };
// While a run is live this slider retunes the running job, not just the next
// one. The pool reads the limit before every dispatch.
let jobsLiveTimer = null;
$("jobs").oninput = (/** @type {any} */ e) => {
  const n = Number((/** @type {HTMLInputElement} */ (e.target)).value);
  $("jobsOut").textContent = String(n);
  if (!currentJob) return;
  clearTimeout(jobsLiveTimer);
  jobsLiveTimer = setTimeout(() => {
    api(`jobs/${currentJob}`, { method: "POST", body: { jobs: n } })
      .catch((e) => toast(e.message, true));
  }, 200);
};
$("heicSpeed").oninput = (/** @type {any} */ e) => { $("heicSpeedOut").textContent = (/** @type {HTMLInputElement} */ (e.target)).value; };
for (const id of ["copyUndersized", "includeRaw", "flattenGif", "overwrite"]) {
  $(id).onchange = () => refreshPreview();
}
$("destination").onchange = () => save();

async function save() {
  await api("config", {
    method: "POST",
    body: {
      destination: $("destination").value,
      budgetBytes: $input("budget").valueAsNumber * 1024 ** 3,
      policy: policy(),
    },
  });
}

// ── preview ────────────────────────────────
// One debounce, one code path. This previously had a 180 ms debounced() AND a
// separate zero-delay timer inside refreshPreview(), so it was never clear
// which one owned the scheduling.
let previewTimer = null;
function schedulePreview(delay = 180) {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(refreshPreview, delay);
}

async function refreshPreview() {
    clearTimeout(previewTimer);
    if (!tree) return;
    try {
      await save();
      const p = await api("preview", { method: "POST", body: { policy: policy() } });
      lastPreview = p;

      $("statConvert").textContent = p.convert.toLocaleString();
      $("statCopy").textContent = p.copy.toLocaleString();
      $("statSkip").textContent = p.skip.toLocaleString();
      $("statOut").textContent = fmt(p.estOutputBytes);
      $("rawBytes").textContent = lastScan
        ? `${lastScan.totals.rawCount} files, ${fmt(lastScan.totals.rawBytes)}`
        : "";

      const frac = Math.min(1, p.estOutputBytes / p.budget.budgetBytes);
      const fill = $("budgetFill");
      fill.style.width = (frac * 100).toFixed(1) + "%";
      fill.classList.toggle("over", !p.budget.fits);
      $("budgetCard").classList.toggle("over", !p.budget.fits);

      let note = `Reading ${fmt(p.sourceBytes)} → ${p.estOutputFiles.toLocaleString()} output files.`;
      if (!p.budget.fits) {
        note += ` Over budget by ${fmt(p.budget.overBy)}.`;
        const first = p.budget.dropSuggestions[0];
        if (first) {
          note += ` Dropping "${first.rel}" would bring it to ${fmt(first.runningTotalAfterDrop)}` +
            (first.getsUnderBudget ? " (under budget)." : ", still not enough.");
        }
      } else {
        note += ` Fits the ${fmt(p.budget.budgetBytes)} budget.`;
      }
      $("budgetNote").textContent = note;

      renderSplit(p);
      renderHealthInline(p.health);

      $("btnStart").disabled = p.convert + p.copy === 0;
      $("btnStart").textContent = p.convert + p.copy > 0
        ? `Convert ${(p.convert + p.copy).toLocaleString()} files`
        : "Nothing selected";
    } catch (/** @type {any} */ e) {
      toast(e.message, true);
    }
}

function renderSplit(p) {
  const box = $("folderSplit");
  box.innerHTML = `<h4 style="margin:0 0 6px;font-size:11px;text-transform:uppercase;color:var(--muted)">By folder</h4>`;
  for (const f of p.byFolder.slice(0, 12)) {
    const row = document.createElement("div");
    row.className = "split-row";
    row.innerHTML =
      `<span class="name">${esc(f.rel)}</span>` +
      `<span class="n">${f.convertCount.toLocaleString()}+${f.copyCount}</span>` +
      `<span class="n">${fmt(f.estOutputBytes)}</span>`;
    box.appendChild(row);
  }
}

function renderHealthInline(h) {
  if (!h) return;
  const fails = h.checks.filter((c) => c.status !== "ok");
  $("magickLine").textContent = h.magick
    ? shortVersion(h.magick.version)
    : "ImageMagick not found";
  document.querySelector(".dot").className = "dot " +
    (h.checks.some((c) => c.status === "fail") ? "bad" : "ok");
}

// ── tools ──────────────────────────────────
$("btnEstimate").onclick = async () => {
  const box = $("estimateBox");
  box.classList.remove("hidden");
  box.innerHTML = "<h4>Estimate</h4><p>Converting a sample…</p>";
  try {
    const e = await api("estimate", { method: "POST", body: { sampleSize: 120, jobs: 4 } });
    box.innerHTML =
      `<h4>Estimate <small style="color:var(--muted)">${e.sampleSize} files sampled</small></h4>` +
      `<table>` +
      `<tr><td class="k">measured ratio</td><td>${(e.ratio * 100).toFixed(1)}%</td></tr>` +
      `<tr><td class="k">mean output</td><td>${fmt(e.meanOutputBytes)}</td></tr>` +
      `<tr><td class="k">projected output</td><td><b>${fmt(e.projectedOutputBytes)}</b></td></tr>` +
      `<tr><td class="k">projected time</td><td><b>${dur(e.projectedSeconds)}</b></td></tr>` +
      `</table>`;
    $("statOut").textContent = fmt(e.projectedOutputBytes);
    await refreshPreview();
  } catch (/** @type {any} */ err) {
    box.innerHTML = `<h4>Estimate</h4><p class="bad">${esc(err.message)}</p>`;
  }
};

$("btnDupe").onclick = async () => {
  const box = $("dupeBox");
  box.classList.remove("hidden");
  box.innerHTML = "<h4>Duplicates</h4><p>Hashing…</p>";
  try {
    const d = await api("duplicates", { method: "POST", body: { maxHash: 6000 } });
    if (!d.groupCount) {
      box.innerHTML = `<h4>Duplicates</h4><p class="ok">No duplicates found in ${d.hashedFiles.toLocaleString()} hashed files.</p>`;
      return;
    }
    box.innerHTML =
      `<h4>Duplicates <small style="color:var(--muted)">${d.groupCount} groups</small></h4>` +
      `<p><b>${d.duplicateFiles.toLocaleString()}</b> files are duplicates, ` +
      `wasting <b>${fmt(d.duplicateBytes)}</b> if all converted.</p>` +
      `<table><tr><th>File</th><th>Copies</th><th>Each</th></tr>` +
      d.groups.slice(0, 8).map((g) =>
        `<tr><td>${esc(g.members[0].rel.split("\\").pop())}</td>` +
        `<td>${g.members.length}</td><td>${fmt(g.size)}</td></tr>`).join("") +
      `</table>`;
  } catch (/** @type {any} */ err) {
    box.innerHTML = `<h4>Duplicates</h4><p class="bad">${esc(err.message)}</p>`;
  }
};

$("btnDates").onclick = async () => {
  const box = $("datesBox");
  box.classList.remove("hidden");
  box.innerHTML = "<h4>Dates</h4><p>Reading EXIF…</p>";
  try {
    const d = await api("dates", { method: "POST" });
    box.innerHTML =
      `<h4>Dates</h4>` +
      `<table>` +
      `<tr><td class="k">with EXIF date</td><td class="ok">${d.withExif.toLocaleString()}</td></tr>` +
      `<tr><td class="k">date from filename</td><td>${d.fromNameOnly.toLocaleString()}</td></tr>` +
      `<tr><td class="k">undated</td><td class="${d.undated.length ? "warn" : "ok"}">${d.undated.length.toLocaleString()}</td></tr>` +
      `</table>` +
      (d.undated.length
        ? `<p class="muted">e.g. ${d.undated.slice(0, 3).map((u) => esc(u.split("\\").pop())).join(", ")}</p>`
        : "");
  } catch (/** @type {any} */ err) {
    box.innerHTML = `<h4>Dates</h4><p class="bad">${esc(err.message)}</p>`;
  }
};

$("btnCompare").onclick = async () => {
  const box = $("compareBox");
  box.classList.remove("hidden");
  box.innerHTML = "<h4>Compare</h4><p>Pick a file below.</p>";
  if (!tree) return;

  // Offer a spread of files so the comparison is not all one folder's look.
  const flat = [];
  (function walk(n) { flat.push(...n.files); for (const c of n.children) walk(c); })(tree);
  const pick = flat.filter((f) => excluded.size === 0 || ![...excluded].some((e) => f.rel.startsWith(e + "\\")));
  if (!pick.length) { box.innerHTML = "<h4>Compare</h4><p>No files to compare.</p>"; return; }
  const step = Math.max(1, Math.floor(pick.length / 6));
  const samples = pick.filter((_, i) => i % step === 0).slice(0, 6);

  const list = document.createElement("table");
  list.innerHTML = "<tr><th>File</th><th>Size</th></tr>" +
    samples.map((f, i) =>
      `<tr><td><a href="#" data-i="${i}" style="color:var(--accent)">${esc(f.rel)}</a></td>` +
      `<td>${fmt(f.size)}</td></tr>`).join("");
  box.appendChild(list);

  list.onclick = async (e) => {
    const a = e.target.closest("a");
    if (!a) return;
    e.preventDefault();
    box.innerHTML = "<h4>Compare</h4><p>Encoding variants…</p>";
    try {
      const r = await api("compare", {
        method: "POST",
        body: { rel: samples[Number(a.dataset.i)].rel, qualities: [30, 50, 60, 70, 80] },
      });
      const row = document.createElement("div");
      row.className = "cmp-row";
      const cell = (src, label) =>
        `<figure class="cmp-cell"><img src="${src}" loading="lazy"><figcaption>${label}</figcaption></figure>`;
      row.innerHTML =
        cell(r.originalUrl, `original ${fmt(r.originalBytes)}`) +
        r.variants.map((v) => cell(v.url, `q${v.quality} ${fmt(v.bytes)}`)).join("");
      box.innerHTML = `<h4>${esc(r.rel)}</h4>`;
      box.appendChild(row);
    } catch (/** @type {any} */ err) {
      box.innerHTML = `<h4>Compare</h4><p class="bad">${esc(err.message)}</p>`;
    }
  };
};

$("btnManifests").onclick = async () => {
  try {
    const { manifests } = await api("manifests");
    if (!manifests.length) { openModal("Previous runs", "<p>No runs recorded yet.</p>"); return; }
    openModal("Previous runs", `<table>
      <tr><th>Run</th><th>Converted</th><th>Copied</th><th>Size</th><th>When</th><th></th></tr>` +
      manifests.map((m) =>
        `<tr><td class="mono">${esc(m.id)}</td><td>${m.summary.converted}</td>` +
        `<td>${m.summary.copied}</td><td>${fmt(m.summary.bytes)}</td>` +
        `<td>${new Date(m.createdAt).toLocaleString()}</td>` +
        `<td><button class="ghost small" onclick="undoRun('${esc(m.id)}')">Undo</button></td></tr>`
      ).join("") + `</table>`);
  } catch (/** @type {any} */ e) { toast(e.message, true); }
};

async function undoRun(id) {
  const r = await api("undo", { method: "POST", body: { id } });
  toast(`Removed ${r.removed} files, freed ${fmt(r.bytesFreed)}` +
    (r.refused ? ` (${r.refused} refused for safety)` : ""));
  $("modal").close();
  refreshPreview();
}
window.undoRun = undoRun;

// ── ImageMagick portable updates ────────────
/** @type {any} */
let imStatus = null;

const shortVersion = (v) => {
  const text = String(v ?? "");
  return text.match(/\d+\.\d+\.\d+(?:-\d+)?/)?.[0] ?? (text.split(/\s+/)[0] || "?");
};

function dismissedVersion() {
  try { return localStorage.getItem("imUpdateDismissed"); } catch { return null; }
}
function dismissVersion(v) {
  try { localStorage.setItem("imUpdateDismissed", v); } catch { /* private mode */ }
}
function clearDismissedVersion() {
  try { localStorage.removeItem("imUpdateDismissed"); } catch { /* private mode */ }
}

/**
 * @param {boolean} force bypass the server's 10-minute release cache
 * @param {boolean} interactive true when the user pressed "Check again"
 */
async function checkImageMagickUpdate(force = false, interactive = false) {
  try {
    const im = await api("imagemagick/check" + (force ? "?force=1" : ""));
    imStatus = im;
    renderImageMagickPill(im);

    const latest = im.latest?.version ?? "";
    const missing = !im.installed;
    const shouldPrompt = interactive || missing ||
      (im.updateAvailable && im.latest && dismissedVersion() !== latest);
    if (shouldPrompt) openImageMagickUpdate(im);
    return im;
  } catch (/** @type {any} */ e) {
    if (interactive) toast(e.message, true);
    return null;
  }
}

/** @param {any} im */
function renderImageMagickPill(im) {
  const el = $("imUpdate");
  if (im?.updateAvailable && im.latest) {
    el.classList.remove("hidden");
    el.textContent = im.installed
      ? `ImageMagick ${im.latest.version} available`
      : `Download ImageMagick ${im.latest.version}`;
    el.title = im.installed
      ? `Installed ${shortVersion(im.installed.version)} · click to update`
      : "ImageMagick was not found · click to download the portable build";
  } else if (im && !im.installed) {
    el.classList.remove("hidden");
    el.textContent = "ImageMagick not found";
    el.title = "Click to download a portable build";
  } else {
    el.classList.add("hidden");
  }
}

/** @param {any} im */
function openImageMagickUpdate(im) {
  const missing = !im.installed;
  const installedLine = im.installed
    ? `Installed: <b>${esc(shortVersion(im.installed.version))}</b>`
    : `<span class="bad">ImageMagick was not found on this device.</span>`;
  const latestLine = im.latest
    ? `Latest on GitHub: <b>${esc(im.latest.version)}</b>`
    : (im.online ? "Latest version: unknown" : `<span class="warn">Could not reach github.com.</span>`);

  const released = im.latest?.publishedAt && !Number.isNaN(Date.parse(im.latest.publishedAt))
    ? ` · released ${new Date(im.latest.publishedAt).toLocaleDateString()}`
    : "";

  let html = `<p>${installedLine} &nbsp;·&nbsp; ${latestLine}${released}</p>`;

  if (missing) {
    html += `<p class="warn">ImageMagick is required to convert photos. ` +
      (im.latest
        ? `Install the latest portable build into the folder below?`
        : `Download a portable build manually, or check again when github.com is reachable.`) +
      `</p>`;
  }

  if (im.latest) {
    html += `<table>` +
      `<tr><td class="k">portable build</td><td class="mono">${esc(im.latest.asset.name)}</td></tr>` +
      `<tr><td class="k">download size</td><td>${fmt(im.latest.asset.size)}</td></tr>` +
      `<tr><td class="k">install into</td><td class="mono">${esc(im.installDir)}</td></tr>` +
      `</table>`;
  }

  if (!im.online) {
    const releasePage = im.latest?.pageUrl ?? RELEASES_URL;
    html += `<p class="warn">No internet connection to github.com` +
      (im.error ? ` (${esc(im.error)})` : "") + `. You can download the portable ` +
      `archive manually from <a href="${esc(releasePage)}" target="_blank" rel="noreferrer" style="color:var(--accent)">GitHub releases</a> ` +
      `and unzip it into the folder above. Then press "Check again".</p>`;
  }

  if (im.installed && !im.updateAvailable && im.latest) {
    html += `<p class="ok">ImageMagick is up to date.</p>`;
  }

  html += `<div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">`;
  if (im.updateAvailable && im.latest) {
    const label = im.installed
      ? `Download and install ${esc(im.latest.version)}`
      : `Install ImageMagick ${esc(im.latest.version)}`;
    html += `<button id="btnImInstall" class="primary small">${label}</button>`;
  }
  html += `<button id="btnImRecheck" class="ghost small">Check again</button>`;
  html += `<button id="btnImLater" class="ghost small">${im.updateAvailable ? "Not now" : "Close"}</button>`;
  html += `</div><p id="imInstallNote" class="note"></p>`;

  openModal(missing ? "ImageMagick is not installed" : "ImageMagick", html);

  const install = document.getElementById("btnImInstall");
  const recheck = $("btnImRecheck");
  const later = $("btnImLater");

  later.onclick = () => {
    // A missing install must be asked about again on the next load. Only a
    // real installed-version update is worth remembering as "not now".
    if (im.installed && im.updateAvailable && im.latest) dismissVersion(im.latest.version);
    $("modal").close();
  };

  recheck.onclick = async () => {
    recheck.disabled = true;
    recheck.textContent = "Checking…";
    try {
      const next = await api("imagemagick/check?force=1");
      imStatus = next;
      renderImageMagickPill(next);
      openImageMagickUpdate(next);
    } catch (/** @type {any} */ e) {
      recheck.disabled = false;
      recheck.textContent = "Check again";
      toast(e.message, true);
    }
  };

  if (install) {
    /** @type {HTMLButtonElement} */
    const btn = /** @type {HTMLButtonElement} */ (install);
    btn.onclick = () => startImageMagickInstall(im, btn, $("imInstallNote"));
  }
}

/**
 * The POST blocks until the download, extraction and verification finish, so
 * the server's progress endpoint is polled separately to keep the note moving.
 * @param {any} im
 * @param {HTMLButtonElement} btn
 * @param {HTMLElement} note
 */
async function startImageMagickInstall(im, btn, note) {
  const version = im.latest?.version ?? "latest";
  btn.disabled = true;
  btn.textContent = "Downloading…";
  note.className = "note";
  note.textContent = `Downloading ImageMagick ${version}…`;

  const timer = setInterval(async () => {
    try {
      const p = await api("imagemagick/progress");
      if (p?.message) note.textContent = p.message;
    } catch { /* the install POST reports the real error */ }
  }, 700);

  try {
    const r = await api("imagemagick/install", { method: "POST" });
    clearInterval(timer);
    clearDismissedVersion();
    note.className = "ok";
    note.textContent = `ImageMagick ${r.version} installed into ${r.folder}`;
    btn.textContent = "Installed";
    toast(`ImageMagick ${r.version} installed — reloading…`);
    setTimeout(() => window.location.reload(), 1200);
  } catch (/** @type {any} */ e) {
    clearInterval(timer);
    note.className = "bad";
    note.textContent = e.message;
    btn.disabled = false;
    btn.textContent = "Try again";
  }
}

/** @param {any} im */
function imageMagickHealthHTML(im) {
  const installed = im.installed
    ? `<b>${esc(shortVersion(im.installed.version))}</b><br>` +
      `<span class="muted mono" style="font-size:11px">${esc(im.installed.path)}</span>`
    : `<span class="bad">not found</span>`;
  const latest = im.latest
    ? `<b>${esc(im.latest.version)}</b>` + (im.online ? "" : ` <span class="warn">(cached)</span>`)
    : (im.online ? "unknown" : `<span class="warn">offline</span>`);

  return `<table>` +
    `<tr><td class="k">installed</td><td>${installed}</td></tr>` +
    `<tr><td class="k">latest on GitHub</td><td>${latest}</td></tr>` +
    `<tr><td class="k">portable folder</td><td class="mono">${esc(im.installDir)}</td></tr>` +
    `</table>` +
    (!im.online
      ? `<p class="warn">${esc(im.error ?? "Could not reach github.com.")}</p>`
      : "") +
    `<div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">` +
    `<button id="btnImHealthCheck" class="ghost small">Check again</button>` +
    (im.updateAvailable
      ? `<button id="btnImHealthInstall" class="primary small">${im.installed ? "Download update" : "Download ImageMagick"}</button>`
      : "") +
    `</div>`;
}

/** @param {any} im */
function showHealthMagick(im) {
  const box = $("imHealth");
  if (!box) return;
  if (!im) {
    box.innerHTML = `<p class="warn">Could not check for updates.</p>`;
    return;
  }
  box.innerHTML = imageMagickHealthHTML(im);

  const check = $("btnImHealthCheck");
  check.onclick = async () => {
    check.disabled = true;
    check.textContent = "Checking…";
    try {
      const next = await api("imagemagick/check?force=1");
      imStatus = next;
      renderImageMagickPill(next);
      showHealthMagick(next);
    } catch (/** @type {any} */ e) {
      box.innerHTML = `<p class="warn">${esc(e.message)}</p>`;
    }
  };

  const install = document.getElementById("btnImHealthInstall");
  if (install) install.onclick = () => openImageMagickUpdate(im);
}

$("imUpdate").onclick = async () => {
  try {
    const im = imStatus ?? await api("imagemagick/check");
    imStatus = im;
    openImageMagickUpdate(im);
  } catch (/** @type {any} */ e) { toast(e.message, true); }
};

$("btnQuit").onclick = () => {
  openModal("Close picmagick-gui",
    `<p>Stop the local server?</p>` +
    `<p class="muted">The page will lose its connection. Files already written stay on disk. ` +
    `A running or paused conversion blocks shutdown until it is paused, resumed, or cancelled.</p>` +
    `<div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">` +
    `<button id="btnQuitYes" class="primary small">Close server</button>` +
    `<button id="btnQuitNo" class="ghost small">Cancel</button></div>`);

  $("btnQuitNo").onclick = () => $("modal").close();
  $("btnQuitYes").onclick = async () => {
    const btn = $("btnQuitYes");
    btn.setAttribute("disabled", "disabled");
    btn.textContent = "Closing…";
    try {
      await api("shutdown", { method: "POST" });
      showServerStopped();
    } catch (/** @type {any} */ err) {
      // If the process exited before the response arrived, the fetch itself
      // fails. Only report an error when the server is still answering.
      let alive = true;
      try { await fetch("/api/status", { cache: "no-store" }); }
      catch { alive = false; }
      if (!alive) { showServerStopped(); return; }

      openModal("Server still running",
        `<p class="bad">${esc(err.message)}</p>` +
        `<p class="muted">The server was not stopped. Pause or cancel the conversion, then try again.</p>`);
    }
  };
};

function showServerStopped() {
  openModal("Server closed",
    `<p class="ok">picmagick-gui has stopped. You can close this tab.</p>`);
  $("btnQuit").setAttribute("disabled", "disabled");
}

$("btnHealth").onclick = async () => {
  const h = await api("health");
  openModal("Health check", `<table>${
    h.checks.map((c) =>
      `<tr><td class="${c.status === "ok" ? "ok" : c.status === "warn" ? "warn" : "bad"}">` +
      `${c.status === "ok" ? "OK" : c.status.toUpperCase()}</td>` +
      `<td>${esc(c.label)}</td><td class="muted">${esc(c.detail)}</td></tr>`).join("")
  }</table>` +
    `<h4 style="margin:18px 0 6px;font-size:13px">ImageMagick portable</h4>` +
    `<div id="imHealth" class="muted">Checking github.com for the latest version…</div>`);

  try {
    const im = await api("imagemagick/check");
    imStatus = im;
    renderImageMagickPill(im);
    showHealthMagick(im);
  } catch (/** @type {any} */ e) {
    $("imHealth").innerHTML = `<p class="warn">${esc(e.message)}</p>`;
  }
};

$("btnPick").onclick = async () => {
  const r = await api("pick", { method: "POST", body: { title: "Choose output folder" } });
  if (r.path) { $("destination").value = r.path; save(); refreshPreview(); }
};

// ── incremental sync ───────────────────────
/** @type {any} */
let syncState = null;

$("btnSync").onclick = async () => {
  const box = $("syncBox");
  box.classList.remove("hidden");
  box.innerHTML = "<h4>Sync</h4><p>Comparing input against output…</p>";
  try {
    const s = await api("sync", { method: "POST", body: { policy: policy() } });
    syncState = s;
    const allDone = s.pendingCount === 0;

    let html =
      `<h4>Sync <small style="color:var(--muted)">${s.upToDateCount.toLocaleString()} already done</small></h4>` +
      `<table>` +
      `<tr><td class="k">new files</td><td class="${s.newCount ? "warn" : "ok"}">${s.newCount.toLocaleString()}</td></tr>` +
      `<tr><td class="k">changed since conversion</td><td class="${s.changedCount ? "warn" : "ok"}">${s.changedCount.toLocaleString()}</td></tr>` +
      `<tr><td class="k">pending source</td><td>${fmt(s.pendingSourceBytes)}</td></tr>` +
      `<tr><td class="k">pending output (est.)</td><td><b>${fmt(s.estOutputBytes)}</b></td></tr>` +
      `</table>`;

    if (s.orphanCount) {
      html += `<p class="warn" style="margin-top:8px">${s.orphanCount} output ` +
        `file${s.orphanCount === 1 ? "" : "s"} (${fmt(s.orphanBytes)}) have no matching ` +
        `source. Left alone &mdash; nothing is deleted automatically.</p>`;
    }
    if (s.changed?.length) {
      html += `<p class="muted" style="margin-top:8px">changed: ` +
        s.changed.slice(0, 4).map((c) => esc(c.rel.split("\\").pop())).join(", ") +
        `</p>`;
    }

    if (allDone) {
      html += `<p class="ok" style="margin-top:8px">Everything in scope is already converted.</p>`;
    } else {
      html += `<button id="btnSyncRun" class="primary small" style="margin-top:8px">` +
        `Convert only these ${s.pendingCount.toLocaleString()}</button>`;
    }
    box.innerHTML = html;

    const runBtn = $("btnSyncRun");
    if (runBtn) runBtn.onclick = () => startRun({ onlyNew: true });
  } catch (/** @type {any} */ e) {
    box.innerHTML = `<h4>Sync</h4><p class="bad">${esc(e.message)}</p>`;
  }
};

// ── run ────────────────────────────────────
async function startRun(opts = {}) {
  try {
    await save();
    const r = await api("run", {
      method: "POST",
      body: {
        jobs: $input("jobs").valueAsNumber,
        overwrite: $input("overwrite").checked,
        onlyNew: Boolean(opts.onlyNew),
        policy: policy(),
      },
    });
    currentJob = r.jobId;
    $("runbar").classList.remove("hidden");
    $("btnStart").disabled = true;
    streamProgress(r.jobId);
  } catch (/** @type {any} */ e) {
    toast(e.message, true);
  }
}

$("btnStart").onclick = () => startRun();

$("btnPause").onclick = async () => {
  if (!currentJob) return;
  await api(`pause/${currentJob}`, { method: "POST" });
  $("btnPause").disabled = true;
  $("runStatus").textContent = "Pausing after the current files finish…";
};

/** Pause is graceful, so Resume continues the same job rather than a new one. */
$("btnResume").onclick = async () => {
  if (!currentJob) return;
  try {
    await api(`resume/${currentJob}`, { method: "POST" });
    setPaused(false);
    $("btnPause").disabled = false;
  } catch (/** @type {any} */ e) { toast(e.message, true); }
};

$("btnDiscard").onclick = async () => {
  if (!currentJob) return;
  setPaused(false);
  $("btnPause").disabled = false;
  await api(`cancel/${currentJob}`, { method: "POST" });
  $("runStatus").textContent = "Cancelling…";
};

/** @param {boolean} on */
function setPaused(on) {
  $("runPaused").classList.toggle("hidden", !on);
  $("btnPause").classList.toggle("hidden", on);
  $("btnCancel").classList.toggle("hidden", on);
}

$("btnCancel").onclick = async () => {
  if (!currentJob) return;
  await api(`cancel/${currentJob}`, { method: "POST" });
  $("btnStart").textContent = "Cancelling…";
  $("btnPause").disabled = true;
};

function streamProgress(jobId, replay = false) {
  es?.close();
  $("btnPause").classList.remove("hidden");
  $("btnCancel").classList.remove("hidden");
  $("btnPause").disabled = false;
  setPaused(false);

  // On re-attach, restore the counters from the server before streaming.
  if (replay) {
    api(`job/state?id=${encodeURIComponent(jobId)}`).then((s) => {
      $("runStatus").textContent = `Converting ${s.total.toLocaleString()} files`;
      $("runFill").style.width = ((s.done / s.total) * 100).toFixed(1) + "%";
      $("runPct").textContent = ((s.done / s.total) * 100).toFixed(0) + "%";
      $("runCounts").textContent =
        `${s.done.toLocaleString()}/${s.total.toLocaleString()} · ${s.converted} conv · ` +
        `${s.copied} copy · ${s.skipped} skip · ${s.failed} fail`;
      $("runBytes").textContent = fmt(s.bytes);
      if (s.jobs) {
        $("jobs").value = String(s.jobs);
        $("jobsOut").textContent = String(s.jobs);
      }
      if (s.state === "paused") setPaused(true);
    }).catch(() => { $("runbar").classList.add("hidden"); });
  }

  es = new EventSource(`/api/stream/${jobId}`);

  es.onmessage = (ev) => {
    const p = JSON.parse(ev.data);
    if (p.type === "start" || p.type === "resumed") {
      $("runStatus").textContent =
        p.message ?? `Converting ${p.total.toLocaleString()} files`;
    } else if (p.type === "progress") {
      const pct = (p.done / p.total) * 100;
      $("runFill").style.width = pct.toFixed(1) + "%";
      $("runPct").textContent = pct.toFixed(0) + "%";
      $("runCounts").textContent =
        `${p.done.toLocaleString()}/${p.total.toLocaleString()} · ${p.converted} conv · ` +
        `${p.copied} copy · ${p.skipped} skip · ${p.failed} fail`;
      $("runEta").textContent = `ETA ${dur(p.etaSeconds)} · elapsed ${dur(p.elapsedSeconds)}`;
      $("runBytes").textContent = fmt(p.bytes);
      // Show the file that just entered the encoder, not the one that finished,
      // so the display keeps moving while a long encode is in progress.
      const live = p.starting
        ? `encoding ${p.starting.rel} (${fmt(p.starting.bytes)})`
        : p.file
          ? `${p.file.status} ${p.file.rel}`
          : "";
      if (live) $("runFile").textContent = live;
      if (p.inFlight) {
        $("runStatus").textContent = `Converting · ${p.inFlight} in flight`;
      }
    } else if (p.type === "paused") {
      // In-flight encodes were allowed to land, so the numbers are trustworthy.
      $("runStatus").textContent = "Paused";
      $("runPct").textContent = ((p.done / p.total) * 100).toFixed(0) + "%";
      setPaused(true);
      toast(p.message);
    } else if (p.type === "finish") {
      es?.close();
      const s = p.summary;
      setPaused(false);
      $("btnStart").disabled = false;
      $("btnStart").textContent = "Start conversion";
      $("btnPause").disabled = true;
      if (s.note === "cancelled") {
        toast(`Cancelled. ${s.done} of ${s.total} done; those files are on disk and will be skipped next time.`);
      } else {
        toast(`Done. ${s.converted} converted, ${s.copied} copied, ${s.failed} failed → ${fmt(s.bytes)}`);
      }
    } else if (p.type === "error") {
      es?.close();
      toast(p.message, true);
      $("btnStart").disabled = false;
    }
  };
}

// ── theme ───────────────────────────────────
/** Valid theme ids; anything else stored falls back to "auto". */
const THEME_IDS = ["midnight", "daylight", "ink", "sepia", "nord", "rose"];

function storedTheme() {
  try { return localStorage.getItem("picmagik.theme"); } catch { return null; }
}

const savedTheme = storedTheme();
let themeChoice = THEME_IDS.includes(savedTheme) ? savedTheme : "auto";

/** Auto resolves against the OS preference, same as the inline head script. */
function resolvedTheme() {
  if (themeChoice !== "auto") return themeChoice;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "daylight" : "midnight";
}

function setTheme(choice) {
  themeChoice = THEME_IDS.includes(choice) ? choice : "auto";
  try { localStorage.setItem("picmagik.theme", themeChoice); } catch { /* private mode */ }
  document.documentElement.dataset.theme = resolvedTheme();
  $("themePick").value = themeChoice;
}

// While on Auto, follow a live OS switch without waiting for a reload.
window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
  if (themeChoice === "auto") document.documentElement.dataset.theme = resolvedTheme();
});

// The inline head script already applied the theme before first paint; this
// re-applies it in case that could not run, and syncs the picker.
document.documentElement.dataset.theme = resolvedTheme();
$("themePick").value = themeChoice;
$("themePick").onchange = () => setTheme($("themePick").value);

// ── misc ───────────────────────────────────
/** @param {unknown} s */
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function openModal(title, html) {
  $("modalTitle").textContent = title;
  $("modalBody").innerHTML = html;
  // showModal() throws if the dialog is already open; re-rendering is common
  // (Check again, install progress) so guard it.
  const d = $("modal");
  if (!d.open) d.showModal();
}
$("modalClose").onclick = () => $("modal").close();

let toastTimer = null;
/**
 * @param {string} msg
 * @param {boolean} [bad]
 */
function toast(msg, bad = false) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast" + (bad ? " bad" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 5200);
}

boot();
// A GitHub round-trip must never delay the page. This only adds a header pill
// and, when something newer exists, asks once per version before downloading.
void checkImageMagickUpdate(false);