# Compakta

A local desktop and browser app for compressing and converting photos and videos
to modern, compact formats (AVIF, JPEG XL, WebP, HEIC, JPEG 2000, JPEG, PNG, AV1,
HEVC, H.264, WebM) without modifying the originals. It scans a folder, lets you
include or exclude subfolders, previews the output against a storage budget,
processes with ImageMagick and FFmpeg, and records every run so it can be undone
precisely.

Everything runs on your machine. There is no account, no telemetry, and no
upload. Outbound requests are limited to GitHub for toolchain checks and self-updates.

## Contents

- [Features](#features)
- [Platform support](#platform-support)
- [Requirements](#requirements)
- [Install and run](#install-and-run)
- [Configuration](#configuration)
- [Using the app](#using-the-app)
- [Defaults](#defaults)
- [ImageMagick](#imagemagick)
- [Safety](#safety)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Project layout](#project-layout)
- [Local API](#local-api)
- [Privacy](#privacy)
- [Out of scope](#out-of-scope)
- [Contributing](#contributing)
- [Releasing](#releasing)
- [License](#license)

## Features

- **Local and private.** The server binds to `127.0.0.1`; photos are read from
  disk and outputs are written to disk. Nothing is uploaded.
- **Folder-level control.** A cached directory tree with tri-state
  include/exclude selection. An explicit include overrides an excluded parent.
- **A real plan before a long run.** Every file is classified as `convert`,
  `copy`, or `skip`, with a storage-budget projection and a measured sample
  estimate.
- **Seven output formats.** JPEG XL, AVIF (default), WebP, HEIC, JPEG 2000,
  JPEG, and PNG share one format selector. Quality and encoder-speed sliders
  change meaning per format, and unsupported formats are disabled based on what
  the detected ImageMagick build can actually write.
- **Safe conversion.** ImageMagick runs in a worker pool. Pause is graceful,
  resume continues from the first unfinished file, and cancelling leaves valid
  completed files on disk.
- **Useful audits.** Duplicate detection, EXIF date reporting, and a visual
  quality comparison.
- **Restartable runs.** Existing outputs are skipped, and a paused job lives in
  the server rather than the browser tab.
- **Precise undo.** Each run writes a manifest. Undo deletes only files created
  by that run and refuses paths outside its destination.
- **Managed ImageMagick.** The app can download and verify the official
  portable build on Windows or the official AppImage on Linux.
- **First-class Windows and Linux support.** Native paths, folder pickers, and
  launchers on both platforms.
- **Optional native window.** Electrobun packages the same app as a Windows or
  Linux desktop app with Bun bundled. The browser launchers remain for source
  runs.
- **Six built-in themes.** Midnight, Daylight, Ink, Sepia, Nord, and Rose, plus
  Auto to follow the system light/dark preference. The choice is remembered in
  the browser and applied before first paint.

## Platform support

| | Windows | Linux |
|---|---|---|
| Supported versions | Windows 10 or 11 | Linux |
| Desktop app | Native window (WebView2) | Native window (WebKitGTK 4.1) |
| Desktop installer | `win-x64-Compakta-Setup.zip` | `linux-x64-Compakta-Setup.tar.gz` |
| Source launcher | `start.bat` | `start.sh` |
| Folder picker | Native PowerShell dialog | `zenity` or `kdialog`; typed-path fallback |
| ImageMagick | Portable Q16 build or system install | System ImageMagick 7 or official AppImage |
| Automatic ImageMagick download | Yes (portable Q16) | Yes on x86_64 (AppImage) |
| Stop the app | Close the window, **Quit**, or close the minimised server window | Close the window, **Quit**, or `Ctrl+C` in the terminal |
| CI | Windows check | Linux check |

Linux on non-x86_64 architectures works when ImageMagick 7 with write support
for the formats you use is installed. The automatic AppImage installer is
x86_64 only. macOS is not officially supported.

## Requirements

- **Source runs:** [Bun](https://bun.sh) 1.1 or newer. The desktop installer
  bundles its own Bun, so nothing needs to be installed first.
- **Desktop runs:** the WebView2 runtime on Windows (included in current Windows
  10 and 11) or GTK 3 and WebKitGTK 4.1 on Linux.
- ImageMagick 7 with write support for the format you choose. Linux requires
  ImageMagick 7; Windows should use ImageMagick 7 as well. AVIF write support is
  required for the default format.
- A current browser for source runs.
- Enough free disk space for the output tree.

The source app has no separate build step. Bun runs the TypeScript server and
serves the browser files directly. The desktop installers are built with
Electrobun; see [Releasing](#releasing).

ImageMagick must be able to **write** the selected format. Check the formats you
plan to use with:

```bash
magick -list format | grep -E "JXL|AVIF|WEBP|HEIC|JP2|JPEG|PNG"    # Linux
magick -list format | findstr "JXL AVIF WEBP HEIC JP2 JPEG PNG"     # Windows
```

A writable format shows `w` in its mode, usually `rw+` or `rw-`. A build showing
`r` or `r--` can read that format but cannot encode it. The app's **Health**
panel reports the selected format, and the format dropdown disables anything the
detected build cannot write.

HEIC is the common exception: many ImageMagick builds read HEIC but cannot write
it. HEIC stays in the dropdown but is disabled until a build reports `HEIC rw`.
The bundled Windows build used for testing (`7.1.2-34`) has `HEIC r--`; use a
build with a HEIC encoder, or choose another format, for HEIC output.

If no usable ImageMagick build is found, the app can install a managed build.
Source runs put it in `imagemagick/` beside the project; the desktop app uses
its per-user app data folder. On Linux, a build that cannot write AVIF also
triggers the AppImage offer.

## Install and run

### Desktop app (Windows and Linux)

Download the installer for your platform from the
[Releases page](https://github.com/esconer/compakta/releases):

| Platform | Download | Install |
|---|---|---|
| Windows 10/11 x64 | `win-x64-Compakta-Setup.zip` | Unzip, then run `Compakta-Setup.exe`. It installs for the current user. |
| Linux x64 | `linux-x64-Compakta-Setup.tar.gz` | Extract, then run `./installer`. |

The desktop app opens its own window and starts the same local server on a free
loopback port. Bun is bundled, so neither Bun nor a terminal is required.
ImageMagick is still required, and the app offers the same managed download as
the browser version.

Linux needs GTK 3, WebKitGTK 4.1, Ayatana AppIndicator, and librsvg. On
Ubuntu 24.04 or Debian 13:

```bash
sudo apt install libgtk-3-0 libwebkit2gtk-4.1-0 libayatana-appindicator3-1 librsvg2-2
```

Windows uses the WebView2 runtime that ships with current Windows 10 and 11. If
the window stays blank, install the
[WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/).

### Automatic In-App Updates

Compakta includes an integrated self-updater:
- **Update Checks**: Checks GitHub Releases for new versions without blocking the UI.
- **Background Downloads**: When a new version is detected, you can choose to download the lean/slim update package (~45 MB) in the background while conversions continue uninterrupted.
- **Safe Application**: Once downloaded, an "Update Ready" badge appears. Clicking it allows you to restart and apply the update whenever you are ready. Any bundled ImageMagick installation is automatically preserved into persistent user storage so you never have to redownload it.
- **Source Users**: For git checkout users, the app indicates that a newer version is available and provides instructions (`git pull && bun install`).

### From source

Clone the repository, then use the Windows or Linux launcher:

```bash
git clone https://github.com/esconer/compakta.git
cd compakta
```

#### Windows (source)

1. Install Bun if it is not already available. In PowerShell:

   ```powershell
   powershell -c "irm bun.sh/install.ps1 | iex"
   ```

   Open a new terminal afterwards so `bun` is on `PATH`.

2. Install the small set of project dependencies:

   ```bat
   bun install
   ```

3. Start the app by double-clicking `start.bat`, or from a terminal:

   ```bat
   start.bat
   ```

`start.bat` starts the server in a detached, minimised window, waits for it to
answer, and opens `http://127.0.0.1:5178`. Close that minimised
**Compakta** window to stop the server, or use **Quit** in the page header.

#### Linux (source)

1. Install Bun if it is not already available:

   ```bash
   curl -fsSL https://bun.sh/install | bash
   ```

   Open a new terminal afterwards so `bun` is on `PATH`.

2. Install dependencies and start the launcher:

   ```bash
   bun install
   chmod +x start.sh
   ./start.sh
   ```

`start.sh` runs the server in the foreground and opens
`http://127.0.0.1:5178` with `xdg-open`. Use **Quit** in the page header or
press `Ctrl+C` in the terminal to stop it. In a headless session, open the URL
manually.

If `zenity` or `kdialog` is installed, the folder buttons open a native picker.
Without either, type the path directly into the source or destination field.

#### Terminal, either platform

```bash
bun install       # first time, or after dependency changes
bun start         # open http://127.0.0.1:5178 yourself
bun start:open    # start and open the browser
bun run dev       # hot-reload the server while editing
```

To use a different port:

```bash
PORT=6000 bun start
```

```powershell
$env:PORT=6000; bun start
```

```bat
set PORT=6000 && bun start
```

`start.bat` assumes the default port `5178`. For a custom port on either
platform, start with `bun start` or `bun start:open` instead of the launcher
scripts.

The server listens on `127.0.0.1` only. It is not exposed to your network and
has no login because it is designed to run on the same machine as the browser.

## Configuration

The first launch uses these defaults:

| Setting | Default |
|---|---|
| Source folder | `~/Pictures`, or the home folder if that does not exist |
| Destination | `<source>-avif` |
| Output format | AVIF |
| Budget | 10 GB |
| Port | `5178` |

You can change the source and destination in the UI, or set startup defaults
with environment variables:

```bat
set COMPAKTA_SOURCE=D:\Photos
set COMPAKTA_DESTINATION=D:\Photos-avif
start.bat
```

```powershell
$env:COMPAKTA_SOURCE = "D:\Photos"
$env:COMPAKTA_DESTINATION = "D:\Photos-avif"
bun start:open
```

```bash
export COMPAKTA_SOURCE="$HOME/Pictures"
export COMPAKTA_DESTINATION="$HOME/Pictures-avif"
bun start:open
```

`COMPAKTA_DESTINATION` defaults to the source path with `-avif` appended. The
legacy `PICMAGIK_SOURCE` / `PICMAGIK_DESTINATION` names still work as a fallback.
Source, destination, budget, and conversion policy are kept in server memory
for the current session. Restarting the server restores these defaults; use the
environment variables when you want a persistent starting point.

When the destination is still the default for the previous format, changing the
output format renames it to the new suffix, for example `Photos-avif` →
`Photos-jxl`. A destination you typed or picked yourself is never rewritten.
Existing outputs from the old format are not deleted; **Sync** reports them as
orphans.

## Using the app

1. **Choose the source and destination.** Type both paths, or use the
   **Browse…** buttons where a native picker is available. The destination must
   be outside the source; the app refuses a destination nested inside the
   source because the mirror would recurse into its own output.

2. **Press Scan.** One walk of the library builds the file list and folder
   tree. Later views reuse that cache.

3. **Choose files and folders.** Expanding a folder lists the files inside it,
   each with its own checkbox. Excluding a folder deselects everything beneath
   it; re-checking one file or one child folder creates an explicit include
   override. A partly selected folder shows a dash. **Filter** narrows the tree
   by file or folder name, and **Expand** / **Collapse** control the whole tree.
   Source-type toggles control which extensions are eligible. RAW is off by
   default and can be enabled in the settings.

4. **Review the plan.** Each file ends up in one bucket:

   - `convert` — encode to the selected output format
   - `copy` — copy the original bytes unchanged
   - `skip` — leave it out

   Files below the minimum size are copied by default; clear **copy under-size
   files** to skip them instead. The budget card shows what fits. **Estimate**
   encodes a real sample instead of guessing a compression ratio. **Duplicates**
   finds identical content by size and MD5. **Dates** reports how many files
   have a real EXIF capture date, a recovered date, or no date. **Compare q**
   shows the original beside several quality levels of the selected format.

5. **Choose the output format and start the conversion.** The format selector
   sits above the quality slider; AVIF is the default. Quality, encoder speed,
   and parallel jobs are in the settings pane. The quality and speed labels,
   ranges, and notes change with the format. **Overwrite** is opt-in; otherwise
   existing outputs are skipped. **Only new** restricts a run to files that sync
   reports as pending. The format selector locks while a run is in progress so
   one run cannot mix formats.

6. **Pause, resume, or cancel.** Pause is graceful: no new work is handed out,
   but encoders already in flight finish and land on disk. Resume continues the
   same job from the first unfinished file. Cancelling keeps completed outputs,
   which are skipped on the next run. A paused job survives closing the browser
   tab; reopening the page reattaches to it.

7. **Verify, sync, and undo.** The local API can verify a finished run by
   decoding outputs and checking dimensions and `DateTimeOriginal`. **Sync**
   reports new, changed, and up-to-date files, plus orphan outputs without
   matching sources. **Runs** lists previous manifests and provides undo.

### Appearance

The **Theme** picker in the header switches between Midnight (the default),
Daylight, Ink, Sepia, Nord, and Rose. **Auto** follows the operating system's
light/dark preference and updates live when the system changes. The choice is
stored in browser storage and applied before first paint, so reloading does not
flash the default palette. Themes change presentation only; conversion
behaviour is unchanged.

### Output formats

The format selector offers seven encoders. AVIF is the default and keeps the
pre-format behaviour; the others are opt-in per run.

| Format | Extension | Default quality | Encoder-speed control |
|---|---|---|---|
| JPEG XL | `.jxl` | q80 | speed 4–9 → `jxl:effort` 7–2; 6 = effort 5 |
| AVIF | `.avif` | q60 | speed 4–9 → `heic:speed`; 6 is the default |
| WebP | `.webp` | q80 | speed 4–9 → `webp:method` 6–1; 6 = method 4 |
| HEIC | `.heic` | q60 | speed 4–9 → `heic:speed`; needs a build with a HEIC encoder |
| JPEG 2000 | `.jp2` | q60 = 20:1 | hidden; the encoder has no useful speed knob here |
| JPEG | `.jpg` | q85 | 4–5 = 4:4:4 progressive, 6 = 4:2:0 progressive, 7–9 = 4:2:0 baseline |
| PNG | `.png` | q90 = zlib 9 | hidden; PNG is lossless |

The quality slider is reused with a format-specific meaning:

- **Lossy quality** (JXL, AVIF, WebP, HEIC, JPEG) is the encoder's quality
  value. Higher means better quality and larger files.
- **JPEG 2000** maps the slider to a compression ratio. q60 means 20:1; higher
  quality means a lower ratio and a larger file. The readout shows both, for
  example `q60 (20:1)`.
- **PNG** is always lossless. The slider maps to the zlib compression level,
  `floor(q / 10)`, so q90 is level 9. Higher levels compress more slowly and
  usually produce smaller files.

Transparency and animation follow the format:

- JXL, AVIF, WebP, HEIC (when the encoder supports alpha), JPEG 2000, and PNG
  keep alpha. JPEG has no alpha channel, so transparent areas are blended onto
  white.
- JXL, AVIF, and WebP can keep animation. **Flatten GIF** still forces frame 0.
  HEIC, JPEG 2000, JPEG, and PNG write only the first frame.
- Copied under-size files keep their original filename and extension. They are
  byte-for-byte copies, not re-encoded outputs.

JXL and JPEG 2000 are output formats only in this version. The scanner does not
treat `.jxl` or `.jp2` files as convertible sources, so the app will not
re-convert its own JXL or JPEG 2000 output. JPEG, PNG, WebP, HEIC, and the other
listed source formats can still be read.

One naming collision remains. If a folder contains `photo.jpg` and an under-size
`photo.webp`, a WebP run converts `photo.jpg` to `photo.webp` and also copies
`photo.webp` to the same path. The converted file is written first; with
**Overwrite** off the copy is skipped, and with it on the copy replaces the
converted file. The app does not rename either file.

Old-format outputs are never deleted automatically. After switching from JXL to
AVIF, for example, **Sync** reports the existing `.jxl` files as orphans and
leaves them alone. **Runs** records the format used by each manifest.

#### AVIF compatibility

The AVIF encoder arguments are unchanged from earlier releases:

```bash
magick <source> -auto-orient -colorspace sRGB -quality 60 -define heic:speed=6 AVIF:<output>
```

AVIF is still the default for a fresh session, still uses q60 and speed 6 out of
the box, and still writes animated AVIF from animated GIFs unless **Flatten GIF**
is enabled. The regression checks assert the exact AVIF command, output paths,
and defaults.

### Pause and restart safety

Resume never redoes a file. The server keeps a set of completed relative paths,
and the converter also skips outputs that already exist on disk. The second
check means a resume still works after a server restart, when the in-memory job
list is gone.

A paused job blocks a new run until it is resumed or cancelled. Existing files
in the destination are never deleted automatically.

## Defaults

| Setting | Default | Notes |
|---|---|---|
| Output format | AVIF | JXL, WebP, HEIC, JPEG 2000, JPEG, and PNG are selectable |
| Quality | `q60` for AVIF | Per-format default: JXL 80, WebP 80, HEIC 60, JPEG 2000 60, JPEG 85, PNG 90 |
| Resize | none | Full resolution kept for print and crop |
| Metadata | kept | `-strip` deliberately omitted |
| Encoder speed | `6` for AVIF/HEIC | JXL 6 = effort 5, WebP 6 = method 4; hidden for JPEG 2000 and PNG |
| RAW | off | Toggle it on per run if you want it |
| Animated GIF | preserved | JXL, AVIF, and WebP keep animation; **Flatten GIF** is optional. HEIC, JPEG 2000, JPEG, and PNG write frame 0 |
| Under-size threshold | 0 MB | Convert every file; raising it copies or drops smaller files |
| Parallel jobs | 2 | Safe for high-resolution images; raise it for ordinary photos |
| Budget | 10 GB | Preview and planning target; it does not stop a run |

**Under-size files.** The default threshold is `0`, so every file is converted.
Raising it saves time, not space: a file below the threshold is copied at its
original size. Clear **Copy under-size files** to skip those files entirely.

**Budget.** The budget panel reports what fits and which folders to drop. It is
a planning aid, not a hard cap; a conversion can finish above the target.

For AVIF, the converter runs the equivalent of:

```bash
magick <source> -auto-orient -colorspace sRGB -quality 60 -define heic:speed=6 AVIF:<output>
```

The other formats use the same read-only pipeline with their own encoder flags;
see [Output formats](#output-formats) for the mapping. There is no `-strip`, no
resize, and no `mogrify`. Originals are never written to.

### Why AVIF quality 60 and encoder speed 6

aom's AV1 encoder dominates the conversion time. Representative q60 timings for
a 24 MP photo:

| Speed | Time | Output | Compared with speed 5 |
|---|---|---|---|
| 4 | 51.2 s | 0.90 MB | Same size, 2.6× slower |
| 5 | 18.2 s | 0.90 MB | Byte-identical to 4 |
| **6** | **4.6 s** | **1.03 MB** | **4× faster, +12% bytes — default** |
| 8 | 2.5 s | 1.05 MB | 7× faster, +14% bytes |
| 10 | 0.4 s | 0 bytes | Broken: exits 0 and writes an empty file |

Speed 6 is the knee of the curve. The UI caps the slider at 9, and the converter
treats an empty output file as a failure regardless of the encoder's exit code.

## ImageMagick

On startup the app searches for a usable ImageMagick build. Builds in
`imagemagick/` in the project root are preferred. On Linux, the app only offers
an automatic AppImage download when no system ImageMagick 7 with AVIF write
support is available; it will not replace a working system build. AVIF is the
default format, so AVIF write support remains the discovery criterion. Other
formats are enabled only when the same build reports write support for them.

If no usable build exists, the page shows an ImageMagick prompt. On Linux, a
build that cannot write AVIF also triggers the AppImage offer. Accepting it
downloads a managed build into `imagemagick/`. The same flow is available from
**Health → ImageMagick** and the header update pill.

### Windows portable build

The updater downloads the official portable Q16 archive for the current CPU
from the
[ImageMagick releases page](https://github.com/ImageMagick/ImageMagick/releases).
Windows 10+ includes `tar.exe`, which can unpack 7z archives; a normal 7-Zip
installation is also supported. The staged `magick.exe` is run and checked for
the expected version and writable AVIF support before it replaces anything.

A managed install looks like:

```text
imagemagick/
  current.txt
  ImageMagick-7.1.2-34-portable-Q16-x64/
    magick.exe
```

Unzipping the archive contents directly into `imagemagick/` also works:

```text
imagemagick/
  magick.exe
  ...
```

The updater removes only folders it created (marked with
`.picmagik-managed`) and stale backups. Hand-placed folders are left alone.

### Linux: system build or AppImage

Linux requires ImageMagick 7. The app looks in the project’s `imagemagick/`
folder, then common locations such as `~/.local/bin`, `/usr/local/bin`,
`/usr/bin`, `/snap/bin`, `/opt/ImageMagick/bin`, and finally `PATH`.

If the system build is missing or cannot write AVIF, the app can install the
official x86_64 AppImage. The `gcc` build is preferred because it has the widest
glibc compatibility; the `clang` build is used when no `gcc` asset is available.
The download is checked against GitHub’s SHA-256 digest when supplied, checked
for the expected byte count, made executable, and tested for AVIF write support
before it is installed.

A managed AppImage looks like:

```text
imagemagick/
  current.txt
  .picmagik-appimage.json
  ImageMagick-7.1.2-34-gcc-x86_64.AppImage
```

A manually downloaded AppImage also works. Make it executable, place it in
`imagemagick/`, and press **Check again**. The newest AppImage in that folder is
discovered by filename.

AppImages normally need FUSE. If FUSE is unavailable, the app retries the first
run with `APPIMAGE_EXTRACT_AND_RUN=1` and keeps that setting for later
conversion workers. For a manual test:

```bash
APPIMAGE_EXTRACT_AND_RUN=1 ./imagemagick/ImageMagick-*.AppImage -version
```

Automatic AppImage installs are x86_64 only. On other architectures, install
ImageMagick 7 with AVIF support from your distribution.

### Update checks

On page load the server asks GitHub for the latest official ImageMagick release
and caches the answer for 10 minutes. If a newer managed build exists, the
header shows an update pill and a one-time prompt offers the download. Choosing
**Not now** dismisses that version; it can be checked again from **Health**.

Updates are refused while a conversion is running or paused, and while another
ImageMagick download is in progress. If GitHub is unreachable, the app keeps
using the installed build and reports the check as offline.

## Safety

1. The source tree is opened read-only and is never written to or deleted from.
2. The destination may not be the source folder or sit inside it.
3. Existing outputs are skipped unless **Overwrite** is enabled.
4. Undo only removes paths recorded in a manifest and only inside that
   manifest’s destination.
5. Only the temporary scratch folder is removed automatically.
6. An empty output file is a failure even when the encoder exits successfully.
7. A killed encoder’s partial output is deleted so the next run cannot mistake
   it for a finished file.
8. A paused job blocks a new run until it is resumed or cancelled.
9. The original-preview route serves only image extensions and caps files at
   64 MB.
10. The ImageMagick updater writes only inside `imagemagick/`, trusts only the
    latest official GitHub release asset, and verifies the staged binary before
    replacing the current install.
11. **Quit** is refused while a conversion is running or paused, or while an
    ImageMagick download is in progress.
12. Outputs from a previous format are never deleted automatically. **Sync**
    reports them as orphans, and undo only removes files listed in the selected
    run’s manifest.

## Troubleshooting

### ImageMagick is missing or read-only

Run the format check shown in [Requirements](#requirements). On Linux, the
distribution may still ship ImageMagick 6; use a current ImageMagick 7 package
or the AppImage. On Windows, install the portable build when the page offers
it, or unzip it into `imagemagick/` manually.

### A format is disabled or read-only

The format dropdown disables any format the detected build cannot write. Check
the exact mode with `magick -list format` (see
[Requirements](#requirements)). HEIC commonly appears as `HEIC r--` on builds
without a HEIC encoder; install a build with HEIC write support or choose a
different format. A format reported as `rw+` or `rw-` is writable.

Switching away from a format does not delete its old outputs. **Sync** lists
them as orphans so you can decide what to keep.

### Windows

- **`bun` is not recognized.** Install Bun and open a new terminal. `start.bat`
  prints the official install command if Bun is missing.
- **The ImageMagick download cannot extract.** Make sure `tar.exe` is available
  (Windows 10 or newer) or install 7-Zip. You can always unzip the portable
  archive into `imagemagick/` yourself.
- **The folder picker does not open.** PowerShell may be restricted. Type the
  path directly into the field instead.
- **The browser does not open.** Visit `http://127.0.0.1:5178` manually. The
  server may still be starting; watch the minimised window for errors.

### Linux

- **`Permission denied` when starting.** Run `chmod +x start.sh` once.
- **No folder picker appears.** Install `zenity` or `kdialog`, or type the path
  directly. The picker also needs a desktop session.
- **ImageMagick 7 is installed but AVIF is read-only.** Install the AVIF/libheif
  support for your distribution, or use the official AppImage.
- **The AppImage fails to mount.** The app automatically retries with
  `APPIMAGE_EXTRACT_AND_RUN=1`. You can also install FUSE 2 if your
  distribution provides it, or run the AppImage manually with that environment
  variable.
- **The browser does not open.** `xdg-open` needs a desktop session. Open
  `http://127.0.0.1:5178` manually, or use `bun start` instead of
  `bun start:open`.
- **ARM64 or another non-x86_64 architecture.** Automatic AppImage installs are
  unavailable. Install ImageMagick 7 with AVIF support from your distribution.

### Desktop app

- **The window is blank on Windows.** Install the WebView2 Runtime linked in
  [Desktop app](#desktop-app-windows-and-linux). Current Windows 10 and 11
  usually include it already.
- **The window does not open on Linux.** Install the GTK 3, WebKitGTK 4.1,
  Ayatana AppIndicator, and librsvg packages listed in the same section. The
  launcher reports a missing shared library when one is absent.
- **The app stops immediately after launch.** Run the platform installer rather
  than the `build/` output. A stable Electrobun bundle is an installer payload;
  only the installed copy has the metadata the launcher needs.
- **Where is the managed ImageMagick build?** Everything writable (managed
  ImageMagick and compare previews) lives in the per-user app data folder, not
  the install folder. Uninstalling can remove it.

### Both platforms

- **Port 5178 is already in use.** Stop the old server, or start on another
  port with `PORT=6000 bun start` (see [Install and run](#install-and-run)).
- **The ImageMagick update check is offline.** The app can still convert with
  the installed build. Check your network, proxy, or GitHub access.
- **A paused job blocks a new run.** Resume or cancel the paused job first.

## Development

```bash
bun install
bun run dev
```

`bun run dev` starts the server with hot reload. Open
`http://127.0.0.1:5178` after it starts.

### Desktop shell

The desktop app is the same server inside an Electrobun window. `src/desktop.ts`
is the main-process entrypoint, `electrobun.config.ts` describes the bundle, and
`hutch.config.ts` pins the Electrobun/Hutch versions.

```bash
bun install
bun run desktop:prepare   # fetch the Electrobun SDK once
bun run desktop:dev       # build and launch the desktop window with reload
bun run desktop:build     # stable installer for the current OS in artifacts/
```

Hutch builds only for the host platform, so a complete release needs one build
per operating system; the release workflow does both.

`src/electrobun.d.ts` is a minimal local declaration for the SDK surface the main
process uses. It keeps `bun run typecheck` working before `.hutch/devkit` has
been generated. Re-check it deliberately when the pinned Electrobun version
changes.

Useful checks:

| Command | Purpose |
|---|---|
| `bun run typecheck` | TypeScript check |
| `bun run src/client.check.ts` | Undefined identifiers and missing element IDs in browser scripts |
| `bun run src/platform.check.ts` | Cross-platform path, AppImage, and safety checks |
| `bun run src/format.check.ts` | AVIF regression contract, format mappings, suffix and manifest checks |
| `bun run check` | Run all of the above |
| `bun run release:check` | `package.json` and `electrobun.config.ts` versions agree |

CI runs the checks and a desktop build on both Windows and Linux. The release
workflow repeats them, then publishes the installers when a `v*` tag is pushed.

## Project layout

```text
src/
  server.ts       routes, static files, SSE, job registry
  desktop.ts      Electrobun main process: server + native window
  appdirs.ts      writable data root (project root or per-user app data)
  electrobun.d.ts minimal typings for the Electrobun main-process SDK
  scan.ts         one walk -> cached file list and directory tree
  policy.ts       selections -> convert | copy | skip
  formats.ts      output-format registry, encoder args, slider mappings
  convert.ts      ImageMagick worker pool, cancel, per-file results
  jobs.ts         run lifecycle and progress events
  estimate.ts     stratified sample -> measured size and time projection
  sync.ts         new / changed / up-to-date analysis
  dedupe.ts       MD5 duplicate detection
  verify.ts       decode and check dimensions / EXIF after a run
  meta.ts         identify, EXIF extraction, date recovery
  budget.ts       what fits under a cap, and what to cut
  manifest.ts     per-run record and precise undo
  health.ts       preflight checks
  platform.ts     OS constants and native path helpers
  paths.ts        ImageMagick discovery and path safety
  imagemagick.ts  release checks, portable/AppImage install and update
  version.ts      version parsing shared by discovery and updates
public/
  index.html      layout
  app.js          UI wiring
  treelogic.js    pure tree logic
  formatlogic.js  pure destination-suffix logic
  style.css       styling and theme palettes
assets/
  icon.png        Linux application icon
  icon.ico        Windows application icon
imagemagick/      managed ImageMagick (downloaded or placed by hand)
electrobun.config.ts  desktop bundle: entrypoint, copied files, icons
hutch.config.ts       Electrobun/Hutch version pin and build tasks
start.bat         Windows launcher
start.sh          Linux launcher
```

`imagemagick/`, `.hutch/`, `.cottontail-tmp/`, `build/`, and `artifacts/` are
intentionally ignored by Git. The managed ImageMagick build is large and fetched
on demand; the rest are generated by Hutch and Electrobun.

## Local API

The browser talks to a small JSON API on the same local server. It is internal,
has no authentication, and should only be reachable on `127.0.0.1`. POST routes
expect a JSON object; send `{}` when there are no fields. Conversion routes use
the selected `outputFormat`; `/api/run` and `/api/compare` reject a format the
detected ImageMagick build cannot write.

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/status` | Config, scan state, free space, available projects |
| `POST` | `/api/config` | Set source, destination, budget, policy |
| `POST` | `/api/validate` | Check a candidate source/destination pair |
| `POST` | `/api/pick` | Open the native folder picker |
| `POST` | `/api/scan` | Walk the library |
| `POST` | `/api/preview` | Apply policy; return counts, budget, and health |
| `POST` | `/api/estimate` | Measured sample projection |
| `POST` | `/api/sync` | New / changed / up-to-date analysis |
| `POST` | `/api/duplicates` | MD5 duplicate scan |
| `POST` | `/api/dates` | EXIF date audit |
| `POST` | `/api/compare` | Quality ladder for one file |
| `POST` | `/api/run` | Start a conversion |
| `GET` | `/api/stream/:id` | SSE progress stream |
| `POST` | `/api/pause/:id` | Graceful pause |
| `POST` | `/api/resume/:id` | Continue a paused job |
| `GET` | `/api/job/state?id=` | Snapshot for reattaching after a refresh |
| `POST` | `/api/cancel/:id` | Cancel a running or paused job |
| `POST` | `/api/verify` | Verify a finished run |
| `GET` | `/api/manifests` | Previous runs |
| `POST` | `/api/undo` | Remove a run’s output |
| `GET` | `/api/health` | Preflight checks |
| `POST` | `/api/shutdown` | Stop the local server when idle |
| `GET` | `/api/imagemagick` | Installed build and cached release info |
| `GET` | `/api/imagemagick/check` | Check GitHub for a newer build |
| `GET` | `/api/imagemagick/progress` | Download / verify / install progress |
| `POST` | `/api/imagemagick/install` | Download and install the latest managed build |
| `GET` | `/api/source-file?rel=` | Read-only source file for the compare view |

## Privacy

- All scanning, conversion, and verification happen locally.
- There are no analytics, telemetry, accounts, or cloud calls.
- The only outbound requests are the ImageMagick release check and an optional
  ImageMagick download, both to GitHub (`api.github.com` and
  `github.com/ImageMagick/ImageMagick`).
- The web server binds to `127.0.0.1` only.

## Out of scope

- Automatic deletion of destination files that have no matching source.
- Watch-folder auto-conversion.
- Automatic ImageMagick downloads on Linux ARM64 or macOS.
- macOS support.

## Contributing

Keep each change focused. Create a branch from `main`, make the change, run
`bun run check`, and open a pull request. Changes that affect path handling or
ImageMagick discovery should pass both the Windows and Linux CI jobs.

## Releasing

The desktop installers are built with Electrobun. Each release needs one native
build per operating system, so the workflow runs a Windows and an Ubuntu job.

1. Bump the version in `package.json`, in `app.version` in
   `electrobun.config.ts`, and in `src/version.ts` (`APP_VERSION`). All three
   must match the tag.
2. Commit, then push a version tag:

   ```bash
   git tag vX.Y.Z
   git push origin main --tags
   ```

The Release workflow:

- installs the Linux GTK 3 and WebKitGTK 4.1 build dependencies;
- runs `bun run check` on both platforms;
- runs `bun run desktop:build` (`electrobun build --env=stable`) on each;
- refuses to continue when the tag, `package.json`, and `electrobun.config.ts`
  versions differ;
- attaches the installers, update archives, and update metadata to the GitHub
  release;
- uses the matching `CHANGELOG.md` section as the start of the release notes,
  followed by GitHub's generated pull-request summary.

A release contains:

| Platform | Installer | Update artifacts |
|---|---|---|
| Windows x64 | `win-x64-Compakta-Setup.zip` | `stable-win-x64-Compakta.tar.zst`, `stable-win-x64-update.json` |
| Linux x64 | `linux-x64-Compakta-Setup.tar.gz` | `stable-linux-x64-Compakta.tar.zst`, `stable-linux-x64-update.json` |

To build for the current OS without publishing:

```bash
bun install
bun run desktop:build
```

Artifacts land in `artifacts/`; the expanded app bundle is in `build/`. Both are
ignored by Git. `bun run desktop:build:canary` produces the canary channel
instead, which installs alongside the stable app.

Electrobun's channel, platform, and filename conventions are fixed. If you later
host updates yourself, set `release.baseUrl` in `electrobun.config.ts` to the
folder URL and upload `artifacts/` without renaming anything; see the
[Electrobun distribution guide](https://framework.blackboard.sh/electrobun/guides/bundling-and-distribution/).

## License

MIT. See [LICENSE](LICENSE).

ImageMagick is distributed under its own license. This project downloads the
official build rather than bundling it.
