/**
 * Health view — readiness verdict, system checks, format support, and the
 * managed ImageMagick / FFmpeg build. Every value is server-reported; the view
 * does not infer writability from a format name.
 */
import { api } from "../api";
import { $, escapeHtml, fmt, icon, relativeTime, shortVersion } from "../dom";
import { state } from "../state";
import type { HealthReport, UpdateStatus } from "../types";
import type { ViewActions } from "./shared";
import { checkIcon, statusWord } from "./shared";

export type HealthViewController = {
  open: () => void;
  refresh: () => Promise<void>;
};

const VIDEO_FORMAT_ROWS: Record<string, { label: string; ext: string }> = {
  av1: { label: "AV1 (CPU)", ext: "mkv / mp4" },
  av1_hw: { label: "AV1 (GPU)", ext: "mkv / mp4" },
  hevc: { label: "HEVC (CPU)", ext: "mkv / mp4" },
  hevc_hw: { label: "HEVC (GPU)", ext: "mkv / mp4" },
  vp9: { label: "VP9", ext: "webm" },
};

export function createHealthView(actions: ViewActions): HealthViewController {
  let busy = false;
  let lastHealth: HealthReport | null = null;
  let lastIm: UpdateStatus | null = null;

  const supportRow = (format: string): string => {
    const isVideo = state.mediaMode === "video";
    const videoSpec = VIDEO_FORMAT_ROWS[format];
    const spec = state.formatSpecs[format];
    const formatMap = (
      isVideo
        ? lastHealth?.magick?.formats
        : lastHealth?.magick?.formats ?? state.status?.magick?.formats
    ) as Record<string, { mode?: string; writable?: boolean; detail?: string }> | undefined;
    const support = formatMap?.[format];
    const writable = support?.writable ?? false;
    return `<tr>
      <td>${escapeHtml(videoSpec?.label ?? spec?.label ?? format)}</td>
      <td class="mono">${escapeHtml(videoSpec?.ext ?? `.${spec?.ext ?? format}`)}</td>
      <td class="mono">${escapeHtml(support?.mode ?? "—")}</td>
      <td class="${writable ? "support-yes" : "support-no"}">${writable ? "Writable" : "Not writable"}</td>
      <td class="muted">${escapeHtml(support?.detail ?? "No encoder reported.")}</td>
    </tr>`;
  };

  const ffmpegCard = (): string => {
    const ff = lastHealth?.magick;
    const hwAv1 = state.videoStatus?.ffmpeg?.hwEncoders?.av1;
    const hwHevc = state.videoStatus?.ffmpeg?.hwEncoders?.hevc;
    const lines: string[] = [];

    if (ff) {
      lines.push(`<div class="fact-row"><span>Installed</span><span>${escapeHtml(shortVersion(ff.version))}</span></div>`);
      lines.push(`<div class="fact-row"><span>Path</span><span class="mono" title="${escapeHtml(ff.path)}">${escapeHtml(ff.path)}</span></div>`);
      lines.push(`<div class="fact-row"><span>GPU encoders</span><span>${escapeHtml([hwAv1, hwHevc].filter(Boolean).join(", ") || "CPU only")}</span></div>`);
    } else {
      lines.push(`<div class="fact-row"><span>Installed</span><span style="color:var(--status-danger)">Not found</span></div>`);
    }

    return `<section class="health-section">
      <div class="section-head"><h3>FFmpeg</h3><span class="chip ${ff ? "ok" : "warn"}">${ff ? "Ready" : "Missing"}</span></div>
      <div class="fact-list">${lines.join("")}</div>
      ${ff ? "" : `<div class="health-actions"><button class="btn primary sm" type="button" data-health-ffmpeg>Install FFmpeg</button></div>`}
    </section>`;
  };

  const imCard = (): string => {
    const im = lastIm;
    if (!im) return `<section class="health-section"><h3>ImageMagick</h3><p class="health-note">Could not read update status.</p></section>`;
    const installed = im.installed;
    const kind = im.assetKind === "appimage" ? "AppImage" : "portable build";
    const platform = state.status?.platform === "linux" ? "Linux" : "Windows";
    const update = im.updateAvailable && im.latest;
    const lines: string[] = [];

    if (installed) {
      lines.push(`<div class="fact-row"><span>Installed</span><span>${escapeHtml(shortVersion(installed.version))}${installed.avifWritable ? "" : " · AVIF unavailable"}</span></div>`);
      lines.push(`<div class="fact-row"><span>Path</span><span class="mono" title="${escapeHtml(installed.path)}">${escapeHtml(installed.path)}</span></div>`);
      if (installed.libheif) lines.push(`<div class="fact-row"><span>libheif</span><span>${escapeHtml(installed.libheif)}</span></div>`);
    } else {
      lines.push(`<div class="fact-row"><span>Installed</span><span style="color:var(--status-danger)">Not found</span></div>`);
    }
    lines.push(`<div class="fact-row"><span>Source</span><span>${im.managed ? `Managed ${escapeHtml(kind)}` : "System ImageMagick"}</span></div>`);
    lines.push(`<div class="fact-row"><span>${im.assetKind === "appimage" ? "AppImage folder" : "Portable folder"}</span><span class="mono" title="${escapeHtml(im.installDir)}">${escapeHtml(im.installDir)}</span></div>`);
    if (im.latest) {
      lines.push(`<div class="fact-row"><span>Latest on GitHub</span><span>${escapeHtml(im.latest.version)}${im.online ? "" : " (cached)"}</span></div>`);
      lines.push(`<div class="fact-row"><span>${kind}</span><span>${escapeHtml(im.latest.asset.name)} · ${fmt(im.latest.asset.size)}</span></div>`);
    }
    lines.push(`<div class="fact-row"><span>Checked</span><span>${escapeHtml(relativeTime(im.checkedAt))}</span></div>`);

    const notes: string[] = [];
    if (!im.supported) {
      notes.push(`Automatic downloads are not available on this ${platform} build. Install ImageMagick 7 with AVIF support using your package manager.`);
    } else if (!im.online) {
      notes.push(`Could not reach github.com${im.error ? `: ${im.error}` : "."} The installed build is still usable.`);
    } else if (im.installed && !im.managed && update && im.assetKind === "appimage") {
      notes.push("The system ImageMagick cannot encode AVIF; the AppImage will take priority after installation.");
    }

    const actions: string[] = [];
    if (im.supported && update && im.latest) {
      actions.push(`<button class="btn primary sm" type="button" data-health-install>${im.installed ? "Download update" : "Install ImageMagick"} ${escapeHtml(im.latest.version)}</button>`);
    }

    return `<section class="health-section">
      <div class="section-head"><h3>ImageMagick</h3><span class="chip ${im.supported ? (im.online ? "ok" : "warn") : "warn"}">${im.supported ? (im.online ? "Supported" : "Offline") : "Manual install"}</span></div>
      <div class="fact-list">${lines.join("")}</div>
      ${notes.map((note) => `<p class="health-note">${escapeHtml(note)}</p>`).join("")}
      <div class="health-actions">${actions.join("")}</div>
    </section>`;
  };

  const render = (): void => {
    const health = lastHealth;
    if (!health) {
      $("healthBody").innerHTML = `<p class="empty-note">Could not read health checks.</p>`;
      return;
    }
    const fails = health.checks.filter((c) => c.status === "fail").length;
    const warns = health.checks.filter((c) => c.status === "warn").length;
    const tone = fails ? "bad" : warns ? "warn" : "ok";
    const pill = $("healthVerdictPill");
    pill.dataset.state = tone === "ok" ? "ok" : tone === "warn" ? "warn" : "bad";
    pill.textContent = fails ? "Needs attention" : warns ? "Usable, with warnings" : "Ready";

    const banner = `<div class="health-banner" data-tone="${tone}">
      <span class="health-icon">${icon(checkIcon(tone === "ok" ? "ok" : tone === "warn" ? "warn" : "fail"), 20)}</span>
      <div>
        <h2>${fails ? "Needs attention before converting" : warns ? "Ready, with warnings" : "Ready to convert"}</h2>
        <p>${health.checks.length} checks · ${fails} failed · ${warns} warnings${health.freeBytes != null ? ` · ${fmt(health.freeBytes)} free` : ""}</p>
      </div>
    </div>`;

    const checks = `<div class="health-grid">${health.checks
      .map((check) => `<div class="health-check" data-status="${check.status}">
        <span class="health-check-icon">${icon(checkIcon(check.status), 16)}</span>
        <div><h4>${escapeHtml(check.label)} <span class="muted">· ${statusWord(check.status)}</span></h4><p>${escapeHtml(check.detail)}</p></div>
      </div>`)
      .join("")}</div>`;

    const isVideo = state.mediaMode === "video";
    const matrix = `<section class="health-section">
      <div class="section-head"><h3>Format support</h3><span class="section-meta">${
        health.magick
          ? escapeHtml(shortVersion(health.magick.version))
          : isVideo
            ? "FFmpeg not found"
            : "ImageMagick not found"
      }</span></div>
      <table class="data-table support-table">
        <thead><tr><th>Format</th><th>Extension</th><th>Mode</th><th>Status</th><th>Encoder</th></tr></thead>
        <tbody>${(isVideo
          ? Object.keys(VIDEO_FORMAT_ROWS)
          : Object.keys(state.formatSpecs).length
            ? Object.keys(state.formatSpecs)
            : ["jxl", "avif", "webp", "heic", "jp2", "jpeg", "png"]
        ).map((id) => supportRow(id)).join("")}</tbody>
      </table>
    </section>`;

    $("healthBody").innerHTML = banner + checks + matrix + (isVideo ? ffmpegCard() : imCard());
  };

  const refresh = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    const isVideo = state.mediaMode === "video";
    $("healthBody").innerHTML = `<p class="empty-note">Reading ${isVideo ? "FFmpeg" : "ImageMagick"}, source, destination, and disk state…</p>`;
    try {
      const [health, im] = await Promise.all([
        api<HealthReport>("health"),
        isVideo ? Promise.resolve(null) : actions.checkMagick(false),
      ]);
      lastHealth = health;
      lastIm = im;
      render();
    } catch (error) {
      $("healthBody").innerHTML = `<p class="inline-msg">${escapeHtml((error as Error).message)}</p>`;
    } finally {
      busy = false;
    }
  };

  $("healthRecheck").addEventListener("click", () => void refresh());

  $("healthBody").addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-health-install]")) {
      void actions.installMagick().then(refresh);
    } else if (target.closest("[data-health-ffmpeg]")) {
      void api("video/ffmpeg/install", { method: "POST", body: {} })
        .then(() => {
          actions.toast("FFmpeg installed successfully!", "success");
          return refresh();
        })
        .catch((err: unknown) => actions.toast((err as Error).message, "danger"));
    }
  });

  const open = (): void => {
    actions.switchView("health");
    void refresh();
  };

  return { open, refresh };
}
