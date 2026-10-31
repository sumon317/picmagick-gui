# Changelog

## 1.3.2 - 2026-10-31

- Fix comparison view preview for non-native original photo formats:
  - Generate full-resolution JPEG display proxies for HEIC, HEIF, TIFF, and camera RAW files in `/api/source-file` so modern browsers and WebView2 can display them side-by-side with compressed variants.
  - Generate lossless PNG display proxies for browser-unsupported output variants (JXL, HEIC, JP2) in `/api/compare` while preserving real encoded byte counts in the quality ladder.
  - Add request cancellation listeners to cleanly abort ImageMagick decode jobs when compare requests change or close.

## 1.3.1 - 2026-10-31

- Rebranded project to Compakta (`esconer/compakta`):
  - Renamed GitHub repository, desktop identifier, and application titles.
  - Added new high-resolution K-press squircle app icon and favicon across web, Windows (`.ico`), and Linux (`.png`).
  - Integrated the new Compakta K-press icon directly into the identity header brand mark with hover glow.
  - Automatic background startup migration from legacy `AppData/picmagick-gui` preserving downloaded ImageMagick/FFmpeg toolchains and previous undo manifests.
  - Self-updater enhanced with dual-target backward compatibility for both Compakta and legacy releases.
  - Added `.svg`, `.png`, and `.ico` MIME type routing for static assets.

## 1.3.0 - 2026-10-31

- Added an isolated, full-featured Video Transcoding Engine powered by FFmpeg:
  - Supports modern and efficient video codecs: AV1 (default via libsvtav1), HEVC / H.265 (libx265), VP9 (libvpx-vp9), and hardware-accelerated encoding (NVIDIA NVENC, Intel QSV, AMD AMF).
  - 1-Click Tinkerer Presets: Archival (lossless/near-lossless CRF 22), Balanced (CRF 28), and Space Saver (1080p 30fps Opus CRF 36).
  - Flexible 3-Mode Destination Layouts: Shadow Merge (mirrors alongside photos), Subfolder (`/video`), and Custom Path.
  - Video Frame Compare Inspector with side-by-side split comparison, zoom, and frame-accurate seeking.
  - Automatic FFmpeg discovery, background installer from trusted official builds, and capability probing.
  - Smart audio transcoding: passes through compressed AAC/Opus, transcodes uncompressed camera PCM to efficient Opus/AAC.
  - Dedicated video job runner with pause, resume, progress telemetry, cancellation, and safe manifest-based undo.
- Complete Photos and Videos Mode Isolation:
  - Strict separation between ImageMagick (photos) and FFmpeg (videos) pipelines.
  - Photos mode cleanly hides video files, video extensions, and redundant badges; folder rollups and context rail steps count only items belonging to the active mode.
- Universal Photo Thumbnails and Lightbox Viewer:
  - Universal thumbnail generation and caching for Apple/Android HEIC, camera RAW formats (DNG, ARW, CR2, NEF, etc.), TIFF, and web formats.
  - Full-screen distraction-free Lightbox modal image viewer with high-resolution rendering, next/previous buttons, and keyboard navigation (`←`, `→`, `Escape`).
  - Cross-platform relative path resolution supporting both forward and backslashes in URL queries and buffered payload streaming.

## 1.2.1 - 2026-10-29

- Added an in-app self-updater that checks GitHub Releases, downloads the lean
  update package in the background, and applies it without interrupting an
  active conversion.
- Redesigned the Compare view to match the inspector layout, with a format
  dropdown, zoom slider, and theme-aware styling.
- Fixed plan step numbers not being optically centered and the plan hero card
  shrinking at narrow widths.
- Restored the SVG icons in health checks and format badges, and fixed their
  descriptions.

## 1.2.0 - 2026-10-28

- Redesigned the UI into a three-pane Obsidian cockpit: Library pane, Recipe
  pane, and Plan/Run pane under a chevron rail navigation.
- Added modular client TypeScript architecture under `src/client/` with atomic
  modules for library, format logic/UI, plan, run lifecycle, and dedicated
  views (audit, compare, health, run, runs).
- Added client bundler script (`bun run build:client`) targeting browser into
  `public/app.js`.
- Modularized stylesheets into `tokens.css`, `base.css`, `layout.css`,
  `components.css`, `themes.css`, and `views.css` supporting six themes and
  daylight light/dark toggling.
- Added dual desktop release packages for Windows and Linux: a slim installer
  (~45 MB) and a full batteries-included installer with ImageMagick pre-bundled
  (~80 MB) that works offline out of the box.
- Added a CPU usage limit slider (10%–100%, default 70%) with live mid-run
  affinity control and process priority throttling, allowing ImageMagick's
  processor utilization to be bounded so the system remains responsive during
  heavy batch jobs.
- Added interactive draggable splitters between the three cockpit panes with
  equal-width (1:1:1) default sizing, ratio persistence in localStorage,
  double-click to reset, and keyboard accessibility.

## 1.1.0 - 2026-10-28

- Added a seven-format output selector: JPEG XL, AVIF (still the default), WebP,
  HEIC, JPEG 2000, JPEG, and PNG. Quality and encoder-speed sliders change
  meaning per format, and formats the detected ImageMagick build cannot write
  are disabled. The selected format locks during a run and is recorded in each
  manifest and the **Runs** table.
- The destination follows the selected format's suffix (`-avif` → `-jxl`, …)
  only while it is still the previous format's default; a custom destination is
  never rewritten.
- Animated sources stay animated for JXL, AVIF, and WebP; HEIC, JPEG 2000,
  JPEG, and PNG write the first frame. JPEG transparency is blended onto white.
- Old-format outputs are never deleted automatically; **Sync** reports them as
  orphans.
- Fixed under-size files marked *copy* being renamed to `.avif` while still
  containing the original JPEG/PNG bytes. Copies now keep their original
  filename and extension.
- AVIF command, defaults, paths, health wording, and animated-GIF handling are
  unchanged; regression checks assert the exact pre-format behaviour.
- Added six themes, selectable from the header: Midnight (default), Daylight,
  Ink, Sepia, Nord, and Rose, plus Auto to follow the system light/dark
  preference. The choice is stored in the browser and applied before first
  paint.
- Fixed the `Malformed JSON body` toast after a page reload or EXIF date audit by
  sending a JSON body with bodyless POST requests.
- Fixed killed or failed AVIF encodes being reported as skipped and leaving a
  zero-byte output that later runs treated as complete. A killed encoder now
  reports its signal instead of an empty error.
- Added Linux x86_64 support alongside Windows, with native path separators and
  platform-aware case handling throughout scan, policy, sync and undo.
- Added verified download and update of the official ImageMagick x86_64 AppImage,
  including SHA-256 checks when available and an `APPIMAGE_EXTRACT_AND_RUN`
  fallback when FUSE is unavailable.
- Linux prefers a system ImageMagick 7 that can write AVIF and never shadows a
  working build with the AppImage.
- Added `zenity`/`kdialog` folder picking on Linux, with a typed-path fallback
  for headless sessions.
- Added `start.sh`, Linux setup documentation, and Windows + Linux CI checks.
- Added an Electrobun desktop app for Windows and Linux. It runs the same local
  server in a native window with Bun bundled, and the release workflow publishes
  per-platform installers plus update archives and metadata.
- Packaged runs keep the managed ImageMagick build and compare previews in the
  per-user app data folder. Source runs keep the existing project-root layout.
- CI now builds the desktop app on Windows and Linux, so packaging failures are
  caught before a release tag is pushed.

## 1.0.0 - 2026-10-21

First public release.

- Local scan of a photo library with a cached folder tree and tri-state include/exclude controls.
- AVIF conversion through ImageMagick with a worker pool, graceful pause/resume and cancellation.
- Budget preview, sample-based size estimation, duplicate detection and an EXIF date audit.
- Post-conversion verification and manifest-based undo.
- Incremental sync of new, changed and already-converted files.
- Portable ImageMagick discovery, GitHub release checks, and verified in-app download/update.
- Page-load prompt when ImageMagick is missing, installing the latest portable Q16 build into `imagemagick/`.
- Header Quit button and `POST /api/shutdown`, refused while a conversion is running or paused.
- Read-only source handling and destination recursion checks.
