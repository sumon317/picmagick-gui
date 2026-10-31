/**
 * Codec definitions, Option A Quality-to-CRF mappings, tinkerer presets,
 * and FFmpeg argument generation for the Video subsystem.
 */
import type { FormatSpec } from "../formats.ts";

export const VIDEO_OUTPUT_FORMATS = [
  "av1",
  "hevc",
  "av1_hw",
  "hevc_hw",
  "vp9",
] as const;

export type VideoOutputFormat = (typeof VIDEO_OUTPUT_FORMATS)[number];

export const DEFAULT_VIDEO_FORMAT: VideoOutputFormat = "av1";

export function isVideoOutputFormat(v: unknown): v is VideoOutputFormat {
  return (
    typeof v === "string" &&
    (VIDEO_OUTPUT_FORMATS as readonly string[]).includes(v)
  );
}

export type VideoContainer = "mp4" | "mkv" | "webm";
export type MaxResolution = 0 | 2160 | 1440 | 1080 | 720;
export type MaxFps = 0 | 60 | 30;
export type AudioMode = "auto" | "copy" | "opus128" | "opus64" | "mute";

export const VIDEO_FORMAT_SPECS: Record<VideoOutputFormat, FormatSpec> = {
  av1: {
    id: "av1",
    label: "AV1 (CPU)",
    shortLabel: "AV1",
    summary: "Best compression efficiency; 10-bit yuv420p10le, tune=0",
    ext: "mp4",
    destinationSuffix: "av1",
    mime: "video/mp4",
    magickPrefix: "",
    quality: {
      kind: "crf-inverted",
      min: 20,
      max: 84,
      step: 2,
      default: 60,
      label: "Quality",
      hint: "Lower CRF = higher quality / larger file; Higher CRF = lower quality / smaller file",
      note: "CRF = 58 - q/2 (e.g. q60 -> CRF 28)",
    },
    speed: {
      min: 3,
      max: 10,
      step: 1,
      default: 6,
      label: "Preset",
      hint: "SVT-AV1 preset 3 (slowest/best) to 10 (fastest)",
      note: "Preset 6 is the sweet spot between speed and efficiency",
      visible: true,
      labels: {
        "3": "preset 3 (slowest)",
        "4": "preset 4",
        "5": "preset 5",
        "6": "preset 6 (balanced)",
        "7": "preset 7",
        "8": "preset 8 (fast)",
        "9": "preset 9",
        "10": "preset 10 (fastest)",
      },
    },
    defaultRatio: 0.22,
    compareQualities: [40, 60, 72],
    supportsAnimation: true,
    supportsTransparency: false,
    transparencyNote: "Video does not support standard PNG transparency",
    animationNote: "Motion video format",
  },
  hevc: {
    id: "hevc",
    label: "HEVC / H.265 (CPU)",
    shortLabel: "H.265",
    summary: "Universal Apple/TV compatibility (-tag:v hvc1); 10-bit",
    ext: "mp4",
    destinationSuffix: "hevc",
    mime: "video/mp4",
    magickPrefix: "",
    quality: {
      kind: "crf-inverted",
      min: 20,
      max: 84,
      step: 2,
      default: 60,
      label: "Quality",
      hint: "Lower CRF = higher quality / larger file; Higher CRF = lower quality / smaller file",
      note: "CRF = 54 - q/2 (e.g. q60 -> CRF 24)",
    },
    speed: {
      min: 4,
      max: 9,
      step: 1,
      default: 6,
      label: "Preset",
      hint: "x265 preset 4 (slower) to 9 (ultrafast)",
      note: "Preset 6 (medium) is balanced",
      visible: true,
      labels: {
        "4": "slower",
        "5": "slow",
        "6": "medium",
        "7": "fast",
        "8": "faster",
        "9": "veryfast",
      },
    },
    defaultRatio: 0.34,
    compareQualities: [40, 60, 72],
    supportsAnimation: true,
    supportsTransparency: false,
    transparencyNote: "Video does not support standard PNG transparency",
    animationNote: "Motion video format",
  },
  av1_hw: {
    id: "av1_hw",
    label: "AV1 (GPU Hardware)",
    shortLabel: "AV1-HW",
    summary: "5×–15× faster encode; requires AV1-capable GPU",
    ext: "mp4",
    destinationSuffix: "av1-gpu",
    mime: "video/mp4",
    magickPrefix: "",
    quality: {
      kind: "crf-inverted",
      min: 20,
      max: 84,
      step: 2,
      default: 60,
      label: "Quality",
      hint: "Hardware CQP/CQ mode",
      note: "Hardware encoder quality",
    },
    speed: {
      min: 3,
      max: 9,
      step: 1,
      default: 6,
      label: "Preset",
      hint: "Hardware speed preset",
      note: "GPU encode preset",
      visible: true,
      labels: {
        "3": "p1 (highest quality)",
        "4": "p2",
        "5": "p3",
        "6": "p4 (balanced)",
        "7": "p5",
        "8": "p6",
        "9": "p7 (fastest)",
      },
    },
    defaultRatio: 0.26,
    compareQualities: [40, 60, 72],
    supportsAnimation: true,
    supportsTransparency: false,
    transparencyNote: "Video does not support standard PNG transparency",
    animationNote: "Motion video format",
  },
  hevc_hw: {
    id: "hevc_hw",
    label: "HEVC (GPU Hardware)",
    shortLabel: "HEVC-HW",
    summary: "Blazing fast hardware H.265 encode",
    ext: "mp4",
    destinationSuffix: "hevc-gpu",
    mime: "video/mp4",
    magickPrefix: "",
    quality: {
      kind: "crf-inverted",
      min: 20,
      max: 84,
      step: 2,
      default: 60,
      label: "Quality",
      hint: "Hardware CQP/CQ mode",
      note: "Hardware encoder quality",
    },
    speed: {
      min: 3,
      max: 9,
      step: 1,
      default: 6,
      label: "Preset",
      hint: "Hardware speed preset",
      note: "GPU encode preset",
      visible: true,
      labels: {
        "3": "p1 (highest quality)",
        "4": "p2",
        "5": "p3",
        "6": "p4 (balanced)",
        "7": "p5",
        "8": "p6",
        "9": "p7 (fastest)",
      },
    },
    defaultRatio: 0.38,
    compareQualities: [40, 60, 72],
    supportsAnimation: true,
    supportsTransparency: false,
    transparencyNote: "Video does not support standard PNG transparency",
    animationNote: "Motion video format",
  },
  vp9: {
    id: "vp9",
    label: "VP9 (WebM)",
    shortLabel: "VP9",
    summary: "Open web standard with -row-mt 1",
    ext: "webm",
    destinationSuffix: "vp9",
    mime: "video/webm",
    magickPrefix: "",
    quality: {
      kind: "crf-inverted",
      min: 20,
      max: 84,
      step: 2,
      default: 60,
      label: "Quality",
      hint: "VP9 CRF mode",
      note: "CRF = 58 - q/2",
    },
    speed: {
      min: 2,
      max: 5,
      step: 1,
      default: 4,
      label: "CPU Used",
      hint: "libvpx-vp9 cpu-used setting (0..5)",
      note: "4 is the recommended default for encoding speed",
      visible: true,
      labels: {
        "2": "quality (cpu-used 2)",
        "3": "good (cpu-used 3)",
        "4": "default (cpu-used 4)",
        "5": "realtime (cpu-used 5)",
      },
    },
    defaultRatio: 0.36,
    compareQualities: [40, 60, 72],
    supportsAnimation: true,
    supportsTransparency: false,
    transparencyNote: "Video does not support standard PNG transparency",
    animationNote: "Motion video format",
  },
};

/**
 * Option A Quality mapping:
 * Left (lower q) = higher CRF / smaller lossy file
 * Right (higher q) = lower CRF / better archival quality
 */
export function videoQualityToCrf(format: VideoOutputFormat, q: number): number {
  const base = format === "hevc" || format === "hevc_hw" ? 54 : 58;
  return Math.round(base - q / 2);
}

export function crfToVideoQuality(format: VideoOutputFormat, crf: number): number {
  const base = format === "hevc" || format === "hevc_hw" ? 54 : 58;
  return Math.round((base - crf) * 2);
}

export function videoQualityDisplay(format: VideoOutputFormat, q: number): string {
  const crf = videoQualityToCrf(format, q);
  return `q${q} (CRF ${crf})`;
}

export function x265PresetName(presetNumber: number): string {
  const rounded = Math.max(4, Math.min(9, Math.round(presetNumber)));
  const map: Record<number, string> = {
    4: "slow",
    5: "medium",
    6: "fast",
    7: "faster",
    8: "veryfast",
    9: "superfast",
  };
  return map[rounded] ?? "medium";
}

export const VIDEO_PRESETS = {
  archival: {
    quality: 72, // CRF 22 (AV1) / 18 (HEVC)
    speed: 5,
    maxResolution: 0 as MaxResolution,
    maxFps: 0 as MaxFps,
    audioMode: "copy" as AudioMode,
  },
  balanced: {
    quality: 60, // CRF 28 (AV1) / 24 (HEVC)
    speed: 6,
    maxResolution: 0 as MaxResolution,
    maxFps: 0 as MaxFps,
    audioMode: "auto" as AudioMode,
  },
  spacesaver: {
    quality: 44, // CRF 36 (AV1) / 32 (HEVC)
    speed: 7,
    maxResolution: 1080 as MaxResolution,
    maxFps: 30 as MaxFps,
    audioMode: "opus64" as AudioMode,
  },
} as const;

export function sanitizeCustomParams(params?: string): string {
  if (!params || !params.trim()) return "";
  const s = params.trim();
  if (/[;&|`$\n\r]/.test(s) || s.startsWith("-") || /\s-[a-zA-Z]/.test(s)) {
    throw new Error(`Unsafe video encoder parameter: "${s}"`);
  }
  return s;
}

export type VideoEncoderArgsOptions = {
  src: string;
  out: string;
  format: VideoOutputFormat;
  container: VideoContainer;
  quality: number;
  speed: number;
  maxResolution?: MaxResolution;
  maxFps?: MaxFps;
  audioMode?: AudioMode;
  sourceAudioCodec?: string | null;
  sourceFps?: number | null;
  isHdr?: boolean;
  colorTransfer?: string | null;
  tenBit?: boolean;
  filmGrain?: number;
  customParams?: string;
  hwEncoderName?: string | null;
  sliceStartSec?: number;
  sliceDurationSec?: number;
  progressPipe?: boolean;
};

export function buildVideoEncoderArgs(o: VideoEncoderArgsOptions): string[] {
  const args: string[] = ["-hide_banner", "-nostdin", "-y"];

  if (o.sliceStartSec != null && o.sliceStartSec > 0) {
    args.push("-ss", o.sliceStartSec.toFixed(3));
  }

  args.push("-i", o.src);

  if (o.sliceDurationSec != null && o.sliceDurationSec > 0) {
    args.push("-t", o.sliceDurationSec.toFixed(3));
  }

  // Map primary video stream, optional audio stream, and container metadata.
  // Clear stream rotation metadata because FFmpeg auto-rotates portrait phone
  // video pixels during decode (analogous to ImageMagick's -auto-orient).
  args.push("-map", "0:v:0");
  const audioMode = o.audioMode ?? "auto";
  if (audioMode !== "mute") {
    args.push("-map", "0:a:0?");
  }
  args.push("-map_metadata", "0", "-metadata:s:v:0", "rotate=0");

  // Build video filter chain (-vf) only when resolution or framerate capping is active
  const vf: string[] = [];
  const maxRes = o.maxResolution ?? 0;
  if (maxRes > 0) {
    // maxResolution is a short-edge height (720p/1080p/1440p/2160p), so cap the
    // short edge and let the long edge follow the aspect ratio. This keeps
    // ultrawide footage (e.g. 2560x1080) from being needlessly downscaled.
    vf.push(
      `scale='if(gt(iw,ih),-2,min(${maxRes},iw))':'if(gt(iw,ih),min(${maxRes},ih),-2)':flags=lanczos`,
    );
  }

  const maxFps = o.maxFps ?? 0;
  if (maxFps > 0 && (!o.sourceFps || o.sourceFps > maxFps + 0.5)) {
    vf.push(`fps=${maxFps}`);
  }

  if (vf.length > 0) {
    args.push("-vf", vf.join(","));
  }

  const crf = videoQualityToCrf(o.format, o.quality);
  const tenBit = o.tenBit !== false;
  const pixFmt = tenBit ? "yuv420p10le" : "yuv420p";
  const custom = sanitizeCustomParams(o.customParams);

  // Video codec flags
  switch (o.format) {
    case "av1": {
      const preset = Math.max(3, Math.min(10, Math.round(o.speed)));
      const svtParams = ["tune=0", "enable-overlays=1", "scd=1"];
      const grain = Math.max(0, Math.min(24, Math.round(o.filmGrain ?? 0)));
      if (grain > 0) {
        svtParams.push(`film-grain=${grain}`, "film-grain-denoise=1");
      }
      if (custom) svtParams.push(custom);

      args.push(
        "-c:v", "libsvtav1",
        "-crf", String(crf),
        "-preset", String(preset),
        "-pix_fmt", pixFmt,
        "-svtav1-params", svtParams.join(":"),
      );
      break;
    }

    case "hevc": {
      const presetName = x265PresetName(o.speed);
      const x265Params = ["log-level=error", "aq-mode=3"];
      if (custom) x265Params.push(custom);

      args.push(
        "-c:v", "libx265",
        "-crf", String(crf),
        "-preset", presetName,
        "-pix_fmt", pixFmt,
        "-tag:v", "hvc1",
        "-x265-params", x265Params.join(":"),
      );
      break;
    }

    case "av1_hw":
    case "hevc_hw": {
      const fallback = o.format === "av1_hw" ? "av1_nvenc" : "hevc_nvenc";
      const enc = o.hwEncoderName || fallback;
      const isHevc = o.format === "hevc_hw";
      args.push("-c:v", enc);

      if (enc.endsWith("_nvenc")) {
        const nvPreset = `p${Math.max(1, Math.min(7, 10 - Math.round(o.speed)))}`;
        args.push(
          "-preset", nvPreset,
          "-rc", "vbr",
          "-cq", String(crf),
          "-b:v", "0",
          "-pix_fmt", tenBit ? "p010le" : "yuv420p",
        );
      } else if (enc.endsWith("_qsv")) {
        const qsvPreset = x265PresetName(o.speed);
        args.push(
          "-preset", qsvPreset,
          "-global_quality", String(crf),
          "-pix_fmt", tenBit ? "p010le" : "nv12",
        );
      } else if (enc.endsWith("_amf")) {
        const amfQuality = o.speed <= 5 ? "quality" : o.speed <= 7 ? "balanced" : "speed";
        args.push(
          "-quality", amfQuality,
          "-rc", "cqp",
          "-qp_i", String(crf),
          "-qp_p", String(crf),
          "-pix_fmt", tenBit ? "p010le" : "yuv420p",
        );
      } else {
        args.push("-qp", String(crf));
      }

      if (isHevc) {
        args.push("-tag:v", "hvc1");
      }
      break;
    }

    case "vp9": {
      const cpuUsed = Math.max(2, Math.min(5, Math.round(o.speed)));
      args.push(
        "-c:v", "libvpx-vp9",
        "-crf", String(crf),
        "-b:v", "0",
        "-cpu-used", String(cpuUsed),
        "-row-mt", "1",
        "-pix_fmt", pixFmt,
      );
      break;
    }
  }

  // Preserve HDR10 / HLG color signaling when encoding 10-bit HDR phone/camera videos
  if (o.isHdr && tenBit) {
    args.push(
      "-color_primaries", "bt2020",
      "-color_trc", o.colorTransfer || "arib-std-b67",
      "-colorspace", "bt2020nc",
    );
  }

  // Audio codec flags
  const container: VideoContainer = o.format === "vp9" ? "webm" : o.container;
  if (audioMode === "mute") {
    args.push("-an");
  } else if (audioMode === "copy") {
    if (container === "webm" && o.sourceAudioCodec && !["opus", "vorbis"].includes(o.sourceAudioCodec)) {
      args.push("-c:a", "libopus", "-b:a", "128k");
    } else {
      args.push("-c:a", "copy");
    }
  } else if (audioMode === "opus128") {
    args.push("-c:a", "libopus", "-b:a", "128k");
  } else if (audioMode === "opus64") {
    args.push("-c:a", "libopus", "-b:a", "64k");
  } else {
    // Smart auto mode
    const srcAudio = (o.sourceAudioCodec ?? "").toLowerCase();
    const isPcm = srcAudio.startsWith("pcm_");
    if (container === "webm" && srcAudio && !["opus", "vorbis"].includes(srcAudio)) {
      args.push("-c:a", "libopus", "-b:a", "128k");
    } else if (isPcm) {
      if (container === "mp4") {
        args.push("-c:a", "aac", "-b:a", "160k");
      } else {
        args.push("-c:a", "libopus", "-b:a", "128k");
      }
    } else {
      args.push("-c:a", "copy");
    }
  }

  if (container === "mp4") {
    args.push("-movflags", "+use_metadata_tags+faststart");
  }

  if (o.progressPipe) {
    args.push("-progress", "pipe:1", "-stats_period", "0.5");
  }

  args.push(o.out);
  return args;
}
