/**
 * Output format registry.
 *
 * This is the single source of truth for everything that differs between
 * output formats: extensions, ImageMagick coders, encoder arguments, slider
 * meanings, and display labels. Conversion, estimation, compare previews,
 * health checks, the server API, and the browser all read from here.
 *
 * Leaf module: it must not import policy.ts, paths.ts, server.ts, or
 * manifest.ts. Those modules import this one.
 */

export const OUTPUT_FORMATS = [
  "jxl", "avif", "webp", "heic", "jp2", "jpeg", "png",
] as const;

export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

/** AVIF stays the default. The dropdown order is the user's efficiency order. */
export const DEFAULT_FORMAT: OutputFormat = "avif";

export function isOutputFormat(value: unknown): value is OutputFormat {
  return typeof value === "string"
    && (OUTPUT_FORMATS as readonly string[]).includes(value);
}

export type QualityKind = "lossy" | "compression" | "rate" | "crf-inverted";

export type FormatSpec = {
  id: OutputFormat | (string & {});
  label: string;
  shortLabel: string;
  summary: string;
  ext: string;
  destinationSuffix: string;
  mime: string;
  magickPrefix: string;

  quality: {
    kind: QualityKind;
    min: number;
    max: number;
    step: number;
    default: number;
    label: string;
    hint: string;
    note: string;
    /** JPEG 2000 only: slider value -> target compression ratio. */
    rateTable?: Record<string, number>;
  };

  speed: {
    min: number;
    max: number;
    step: number;
    default: number;
    label: string;
    hint: string;
    note: string;
    visible: boolean;
    /** Human-readable output for each slider value. Keys are speed values. */
    labels: Record<string, string>;
  };

  defaultRatio: number;
  compareQualities: number[];
  supportsAnimation: boolean;
  supportsTransparency: boolean;
  transparencyNote: string;
  animationNote: string;
};

const JXL_EFFORT: Record<number, number> = {
  4: 7, 5: 6, 6: 5, 7: 4, 8: 3, 9: 2,
};

export function jxlEffort(speed: number): number {
  return JXL_EFFORT[Math.round(speed)] ?? 5;
}

export function webpMethod(speed: number): number {
  return Math.max(1, Math.min(6, 10 - Math.round(speed)));
}

const JP2_RATE: Record<number, number> = {
  20: 80, 25: 70, 30: 60, 35: 50, 40: 40, 45: 35,
  50: 30, 55: 25, 60: 20, 65: 17, 70: 15, 75: 12,
  80: 10, 85: 7, 90: 5,
};

export function jp2Rate(quality: number): number {
  const q = Math.max(20, Math.min(90, Math.round(quality / 5) * 5));
  return JP2_RATE[q] ?? 20;
}

const JXL_SPEED_LABELS: Record<string, string> = {
  "4": "effort 7", "5": "effort 6", "6": "effort 5",
  "7": "effort 4", "8": "effort 3", "9": "effort 2",
};

const WEBP_SPEED_LABELS: Record<string, string> = {
  "4": "method 6", "5": "method 5", "6": "method 4",
  "7": "method 3", "8": "method 2", "9": "method 1",
};

const JPEG_SPEED_LABELS: Record<string, string> = {
  "4": "4:4:4 prog", "5": "4:4:4 prog", "6": "4:2:0 prog",
  "7": "4:2:0 base", "8": "4:2:0 base", "9": "4:2:0 base",
};

const NUMERIC_SPEED_LABELS: Record<string, string> = {
  "4": "4", "5": "5", "6": "6", "7": "7", "8": "8", "9": "9",
};

export const FORMAT_SPECS: Record<OutputFormat, FormatSpec> = {
  jxl: {
    id: "jxl",
    label: "JPEG XL",
    shortLabel: "JXL",
    summary: "Best compression in this set, slower to encode.",
    ext: "jxl",
    destinationSuffix: "jxl",
    mime: "image/jxl",
    magickPrefix: "JXL:",
    quality: {
      kind: "lossy",
      min: 20, max: 90, step: 5, default: 80,
      label: "Quality",
      hint: "JPEG XL q",
      note: "q80 is the default. Use q90+ for critical images.",
    },
    speed: {
      min: 4, max: 9, step: 1, default: 6,
      label: "Encoder speed",
      hint: "libjxl effort",
      note: "Lower is slower and smaller; higher is faster and larger. 6 = effort 5.",
      visible: true,
      labels: JXL_SPEED_LABELS,
    },
    defaultRatio: 0.25,
    compareQualities: [50, 70, 80, 85, 90],
    supportsAnimation: true,
    supportsTransparency: true,
    transparencyNote: "Transparency is preserved.",
    animationNote: "Animated sources stay animated.",
  },

  avif: {
    id: "avif",
    label: "AVIF",
    shortLabel: "AVIF",
    summary: "AV1 still image. The default.",
    ext: "avif",
    destinationSuffix: "avif",
    mime: "image/avif",
    magickPrefix: "AVIF:",
    quality: {
      kind: "lossy",
      min: 20, max: 90, step: 5, default: 60,
      label: "Quality",
      hint: "AVIF q",
      note:
        "q60 is the default and gives the best balance between size and quality. " +
        "Use q70–80 for critical images, q30–50 only for thumbnails/smaller copies.",
    },
    speed: {
      min: 4, max: 9, step: 1, default: 6,
      label: "Encoder speed",
      hint: "aom AV1",
      note:
        "6 is the default and works best. Higher is faster and slightly larger. " +
        "10 is not offered: it exits successfully but writes an empty file.",
      visible: true,
      labels: NUMERIC_SPEED_LABELS,
    },
    defaultRatio: 0.174,
    compareQualities: [30, 50, 60, 70, 80],
    supportsAnimation: true,
    supportsTransparency: true,
    transparencyNote: "Transparency is preserved.",
    animationNote: "Animated sources stay animated unless Flatten GIF is on.",
  },

  webp: {
    id: "webp",
    label: "WebP",
    shortLabel: "WebP",
    summary: "Small files with wide browser support.",
    ext: "webp",
    destinationSuffix: "webp",
    mime: "image/webp",
    magickPrefix: "WEBP:",
    quality: {
      kind: "lossy",
      min: 20, max: 90, step: 5, default: 80,
      label: "Quality",
      hint: "WebP q",
      note: "q80 is the default.",
    },
    speed: {
      min: 4, max: 9, step: 1, default: 6,
      label: "Encoder speed",
      hint: "libwebp method",
      note:
        "Lower is slower and slightly smaller; higher is faster and larger. " +
        "6 = method 4.",
      visible: true,
      labels: WEBP_SPEED_LABELS,
    },
    defaultRatio: 0.21,
    compareQualities: [30, 50, 60, 70, 80],
    supportsAnimation: true,
    supportsTransparency: true,
    transparencyNote: "Transparency is preserved.",
    animationNote: "Animated sources stay animated.",
  },

  heic: {
    id: "heic",
    label: "HEIC",
    shortLabel: "HEIC",
    summary: "Apple-friendly HEIC; needs an ImageMagick build with a HEIC encoder.",
    ext: "heic",
    destinationSuffix: "heic",
    mime: "image/heic",
    magickPrefix: "HEIC:",
    quality: {
      kind: "lossy",
      min: 20, max: 90, step: 5, default: 60,
      label: "Quality",
      hint: "HEIC q",
      note: "q60 is the default.",
    },
    speed: {
      min: 4, max: 9, step: 1, default: 6,
      label: "Encoder speed",
      hint: "libheif speed",
      note: "6 is the default. Lower is slower and smaller.",
      visible: true,
      labels: NUMERIC_SPEED_LABELS,
    },
    defaultRatio: 0.18,
    compareQualities: [30, 50, 60, 70, 80],
    supportsAnimation: false,
    supportsTransparency: true,
    transparencyNote: "Transparency is preserved when the encoder supports alpha.",
    animationNote: "Only the first frame is written.",
  },

  jp2: {
    id: "jp2",
    label: "JPEG 2000",
    shortLabel: "JP2",
    summary: "Archival JPEG 2000; larger files than JXL/AVIF.",
    ext: "jp2",
    destinationSuffix: "jp2",
    mime: "image/jp2",
    magickPrefix: "JP2:",
    quality: {
      kind: "rate",
      min: 20, max: 90, step: 5, default: 60,
      label: "Quality",
      hint: "JPEG 2000 ratio",
      note:
        "The value maps to a compression ratio. 60 = 20:1; higher quality " +
        "means a lower ratio and a larger file.",
      rateTable: JP2_RATE,
    },
    speed: {
      min: 4, max: 9, step: 1, default: 6,
      label: "Encoder speed",
      hint: "—",
      note: "Hidden: jp2:number-resolutions had no measurable effect at a fixed rate.",
      visible: false,
      labels: {},
    },
    defaultRatio: 0.52,
    compareQualities: [20, 40, 60, 80, 90],
    supportsAnimation: false,
    supportsTransparency: true,
    transparencyNote: "Transparency is preserved.",
    animationNote: "Only the first frame is written.",
  },

  jpeg: {
    id: "jpeg",
    label: "JPEG",
    shortLabel: "JPEG",
    summary: "Universal, no transparency.",
    ext: "jpg",
    destinationSuffix: "jpg",
    mime: "image/jpeg",
    magickPrefix: "JPEG:",
    quality: {
      kind: "lossy",
      min: 20, max: 90, step: 5, default: 85,
      label: "Quality",
      hint: "JPEG q",
      note: "q85 is the default.",
    },
    speed: {
      min: 4, max: 9, step: 1, default: 6,
      label: "Encoder speed",
      hint: "libjpeg-turbo",
      note: "4–5 = 4:4:4 progressive; 6 = 4:2:0 progressive; 7–9 = 4:2:0 baseline.",
      visible: true,
      labels: JPEG_SPEED_LABELS,
    },
    defaultRatio: 0.38,
    compareQualities: [30, 50, 70, 85, 90],
    supportsAnimation: false,
    supportsTransparency: false,
    transparencyNote: "Transparent areas become white.",
    animationNote: "Only the first frame is written.",
  },

  png: {
    id: "png",
    label: "PNG",
    shortLabel: "PNG",
    summary: "Lossless, largest files.",
    ext: "png",
    destinationSuffix: "png",
    mime: "image/png",
    magickPrefix: "PNG:",
    quality: {
      kind: "compression",
      min: 20, max: 90, step: 5, default: 90,
      label: "Compression",
      hint: "lossless",
      note: "PNG is always lossless. Higher values compress more and take longer.",
    },
    speed: {
      min: 4, max: 9, step: 1, default: 6,
      label: "Encoder speed",
      hint: "—",
      note: "Hidden: PNG has no separate speed control.",
      visible: false,
      labels: {},
    },
    defaultRatio: 1.0,
    compareQualities: [20, 40, 60, 75, 90],
    supportsAnimation: false,
    supportsTransparency: true,
    transparencyNote: "Transparency is preserved.",
    animationNote: "Only the first frame is written; no APNG in this version.",
  },
};

export type EncoderArgsOptions = {
  srcArg: string;
  out: string;
  format: OutputFormat;
  quality: number;
  speed: number;
  /** Long-edge pixel cap; 0/undefined keeps the original resolution. */
  maxResolution?: number;
  /** Strip EXIF/GPS metadata while keeping the pixels. */
  stripMetadata?: boolean;
};

/**
 * Build the exact ImageMagick argument list for one output.
 *
 * The AVIF branch is a literal copy of the pre-format-selection command. Do
 * not add, remove, or reorder flags there: that command is the regression
 * contract for the whole feature. Resize/strip are appended only when the
 * user opts in, so the default argument list is unchanged.
 */
export function buildEncoderArgs(o: EncoderArgsOptions): string[] {
  const base = [o.srcArg, "-auto-orient", "-colorspace", "sRGB"];

  if (o.maxResolution && o.maxResolution > 0) {
    base.push("-resize", `${o.maxResolution}x${o.maxResolution}>`);
  }
  if (o.stripMetadata) {
    base.push("-strip");
  }

  switch (o.format) {
    case "avif":
      return [
        ...base,
        "-quality", String(o.quality),
        "-define", `heic:speed=${o.speed}`,
        `AVIF:${o.out}`,
      ];

    case "jxl":
      return [
        ...base,
        "-quality", String(o.quality),
        "-define", `jxl:effort=${jxlEffort(o.speed)}`,
        `JXL:${o.out}`,
      ];

    case "webp":
      return [
        ...base,
        "-quality", String(o.quality),
        "-define", `webp:method=${webpMethod(o.speed)}`,
        `WEBP:${o.out}`,
      ];

    case "heic":
      // Only reachable when the detected build reports HEIC write support.
      // The flags mirror AVIF; this branch is unverified in the bundled build
      // because that build has no HEIC encoder.
      return [
        ...base,
        "-quality", String(o.quality),
        "-define", `heic:speed=${o.speed}`,
        `HEIC:${o.out}`,
      ];

    case "jp2":
      // JPEG 2000 uses a compression ratio, not -quality. -quality would be
      // interpreted as a PSNR target and produces much larger files.
      return [
        ...base,
        "-define", `jp2:rate=${jp2Rate(o.quality)}`,
        `JP2:${o.out}`,
      ];

    case "jpeg":
      return [
        ...base,
        // JPEG has no alpha channel. Blend onto white rather than writing
        // undefined/black pixels where the source was transparent.
        "-background", "white",
        "-alpha", "remove",
        "-alpha", "off",
        "-quality", String(o.quality),
        "-sampling-factor", o.speed <= 5 ? "4:4:4" : "4:2:0",
        "-interlace", o.speed <= 6 ? "Plane" : "None",
        `JPEG:${o.out}`,
      ];

    case "png":
      // PNG is lossless. ImageMagick maps -quality to the zlib compression
      // level: q20 -> 2, q60 -> 6, q90 -> 9.
      return [
        ...base,
        "-quality", String(o.quality),
        `PNG:${o.out}`,
      ];
  }

  const unreachable: never = o.format;
  throw new Error(`Unknown output format: ${unreachable}`);
}

/**
 * Choose the source argument for one output.
 *
 * HEIC/JPEG 2000/JPEG/PNG cannot hold multiple frames at the expected output
 * path. Without [0], ImageMagick writes photo-0.jpg, photo-1.jpg, … instead of
 * photo.jpg, which breaks outputPathFor and sync.
 */
export function sourceArgFor(
  abs: string,
  ext: string,
  format: OutputFormat,
  flattenGif: boolean,
): string {
  if (format === "heic" || format === "jp2" || format === "jpeg" || format === "png") {
    return `${abs}[0]`;
  }

  // Preserve the exact existing AVIF/WebP behaviour. JXL also preserves
  // animation, verified with the bundled build.
  return flattenGif && ext === "gif" ? `${abs}[0]` : abs;
}

export function qualityDisplay(format: OutputFormat, q: number): string {
  const spec = FORMAT_SPECS[format];
  if (spec.quality.kind === "compression") {
    return `level ${Math.max(0, Math.min(9, Math.floor(q / 10)))}`;
  }
  if (spec.quality.kind === "rate") {
    return `q${q} (${jp2Rate(q)}:1)`;
  }
  return `q${q}`;
}

export function speedDisplay(format: OutputFormat, speed: number): string {
  return FORMAT_SPECS[format].speed.labels[String(speed)] ?? String(speed);
}
