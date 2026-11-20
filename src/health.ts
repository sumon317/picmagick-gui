/**
 * Health check: everything that would silently ruin a long run, surfaced up front.
 */
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { assertDestinationSafe, findMagick, freeSpace, type MagickInfo } from "./paths.ts";
import { FORMAT_SPECS, type OutputFormat } from "./formats.ts";

export type HealthCheck = {
  id: string;
  label: string;
  status: "ok" | "warn" | "fail";
  detail: string;
};

export type HealthReport = {
  checks: HealthCheck[];
  magick: MagickInfo | null;
  canRun: boolean;
  /** Reused by the preview route instead of probing disk a second time. */
  freeBytes: number | null;
};

export async function runHealthCheck(
  sourceRoot: string,
  destination: string,
  expectedOutputBytes: number,
  format: OutputFormat = "avif",
): Promise<HealthReport> {
  const checks: HealthCheck[] = [];
  let magick: MagickInfo | null = null;

  // --- magick presence and selected-format write support ---
  try {
    magick = findMagick();
    checks.push({ id: "magick", label: "ImageMagick", status: "ok", detail: `${magick.version}` });
  } catch (err) {
    checks.push({
      id: "magick", label: "ImageMagick", status: "fail",
      detail: (err as Error).message.split("\n")[0],
    });
  }

  if (magick) {
    const spec = FORMAT_SPECS[format];
    const support = magick.formats[format];
    const writable = support?.writable ?? false;
    checks.push({
      id: format === "avif" ? "avif" : "format",
      label: `${spec.label} write support`,
      status: writable ? "ok" : "fail",
      detail: writable
        ? format === "avif"
          ? `AVIF ${support.mode} via libheif ${support.detail ?? "?"}`
          : `${spec.label} ${support.mode}${support.detail ? ` via ${support.detail}` : ""}`
        : format === "avif"
          ? `AVIF is '${support?.mode ?? ""}' - read only, cannot encode`
          : `${spec.label} is '${support?.mode || "missing"}' - cannot encode`,
    });
  }

  // --- source readable ---
  try {
    const st = await stat(sourceRoot);
    if (st.isDirectory()) await access(sourceRoot, constants.R_OK);
    checks.push({
      id: "source",
      label: "Source readable",
      status: st.isDirectory() ? "ok" : "fail",
      detail: sourceRoot,
    });
  } catch (err) {
    checks.push({
      id: "source", label: "Source readable", status: "fail",
      detail: (err as Error).message,
    });
  }

  // --- destination safety (never inside source) ---
  try {
    assertDestinationSafe(sourceRoot, destination);
  } catch (err) {
    checks.push({
      id: "dest-safe",
      label: "Output safety",
      status: "fail",
      detail: (err as Error).message,
    });
  }

  // --- destination writable ---
  try {
    const st = await stat(destination);
    if (!st.isDirectory()) {
      checks.push({
        id: "dest",
        label: "Output writable",
        status: "fail",
        detail: `${destination} is a file, not a directory`,
      });
    } else {
      await access(destination, constants.W_OK);
      checks.push({ id: "dest", label: "Output writable", status: "ok", detail: destination });
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      let ancestor = path.dirname(path.resolve(destination));
      while (ancestor && ancestor !== path.dirname(ancestor)) {
        try { await stat(ancestor); break; } catch { ancestor = path.dirname(ancestor); }
      }
      let parentWritable = false;
      try { await access(ancestor, constants.W_OK); parentWritable = true; } catch { /* not writable */ }
      checks.push({
        id: "dest",
        label: "Output writable",
        status: parentWritable ? "warn" : "fail",
        detail: parentWritable
          ? `${destination} - will be created`
          : `${destination} - parent folder "${ancestor}" is not writable`,
      });
    } else {
      checks.push({
        id: "dest",
        label: "Output writable",
        status: "fail",
        detail: `${destination} - not writable (${(err as Error).message.slice(0, 60)})`,
      });
    }
  }

  // --- disk headroom ---
  const free = await freeSpace(destination);
  if (free === null) {
    checks.push({
      id: "disk", label: "Disk space", status: "warn",
      detail: "could not determine free space",
    });
  } else {
    // Copying needs room for the output; encoding writes incrementally so
    // headroom is less critical, but a full disk mid-run corrupts the tail.
    const headroom = free - expectedOutputBytes;
    checks.push({
      id: "disk",
      label: "Disk space",
      status: headroom > 512 * 1024 * 1024 ? "ok" : headroom > 0 ? "warn" : "fail",
      detail: `${(free / 1024 ** 3).toFixed(1)} GB free, need ~${(expectedOutputBytes / 1024 ** 3).toFixed(2)} GB` +
        (headroom > 0 ? ` (${(headroom / 1024 ** 3).toFixed(1)} GB spare)` : " - NOT ENOUGH"),
    });
  }

  const canRun = !checks.some((c) => c.status === "fail");
  return { checks, magick, canRun, freeBytes: free };
}