/**
 * Reading image facts out of magick: dimensions, format, EXIF.
 *
 * Used by three features: the EXIF preservation report, the undated-file
 * finder, and post-convert verification.
 */
import { spawn } from "node:child_process";

export type ImageFacts = {
  path: string;
  ok: boolean;
  format?: string;
  width?: number;
  height?: number;
  depth?: number;
  colorspace?: string;
  orientation?: string;
  filesize?: number;
  dateOriginal?: string;
  make?: string;
  model?: string;
  gps?: string;
  iccProfile?: string;
  error?: string;
};

/**
 * Property probes, one per slot, joined by a separator magick will never emit.
 * Labels are carried alongside rather than inline, so a value can never come
 * back with its own label still glued to the front.
 */
const PROBE_FIELDS = [
  { key: "format", expr: "%m" },
  { key: "width", expr: "%w" },
  { key: "height", expr: "%h" },
  { key: "depth", expr: "%z" },
  { key: "colorspace", expr: "%[colorspace]" },
  { key: "orientation", expr: "%[orientation]" },
  { key: "filesize", expr: "%b" },
  { key: "dateOriginal", expr: "%[EXIF:DateTimeOriginal]" },
  { key: "make", expr: "%[EXIF:Make]" },
  { key: "model", expr: "%[EXIF:Model]" },
  { key: "gps", expr: "%[EXIF:GPSLatitude]" },
  { key: "iccProfile", expr: "%[profile:icc]" },
] as const;

const PROBE = PROBE_FIELDS.map((f) => f.expr).join("\x1f");
const SEP = "\x1f";

export function identify(
  magickPath: string,
  file: string,
  signal?: AbortSignal,
): Promise<ImageFacts> {
  if (signal?.aborted) {
    return Promise.resolve({ path: file, ok: false, error: "aborted" });
  }
  return new Promise((resolve) => {
    const c = spawn(magickPath, ["identify", "-quiet", "-format", PROBE, file + "[0]"], {
      windowsHide: true,
      env: { ...process.env, MAGICK_THREAD_LIMIT: "1" },
    });
    const onAbort = () => {
      try { c.kill(); } catch { /* already gone */ }
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    let out = "";
    let err = "";
    c.stdout.on("data", (d) => { if (out.length < 4000) out += String(d); });
    c.stderr.on("data", (d) => { if (err.length < 2000) err += String(d); });
    c.on("error", (e) => {
      signal?.removeEventListener("abort", onAbort);
      resolve({ path: file, ok: false, error: String(e.message ?? e) });
    });
    c.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted || code !== 0 || !out.trim()) {
        resolve({ path: file, ok: false, error: err.trim().slice(0, 300) || `exit ${code}` });
        return;
      }
      const parts = out.trim().split(SEP);
      const facts: ImageFacts = { path: file, ok: true };
      PROBE_FIELDS.forEach((f, i) => {
        const v = parts[i]?.trim();
        if (!v) return;
        if (f.key === "width" || f.key === "height" || f.key === "depth" || f.key === "filesize") {
          const n = Number(v);
          if (Number.isFinite(n)) (facts as Record<string, unknown>)[f.key] = n;
        } else {
          (facts as Record<string, unknown>)[f.key] = v;
        }
      });
      resolve(facts);
    });
  });
}

export async function identifyMany(
  magickPath: string,
  files: string[],
  jobs = 8,
  signal?: AbortSignal,
): Promise<ImageFacts[]> {
  const out: ImageFacts[] = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(jobs, files.length || 1)) }, async () => {
      while (cursor < files.length && !signal?.aborted) {
        const f = files[cursor++];
        out.push(await identify(magickPath, f, signal));
      }
    }),
  );
  return out;
}

/** Filename dates like 20240724_225458 or IMG_20240724_225458 are a usable fallback. */
const NAME_DATE = /(?:^|[^\d])(\d{4})(\d{2})(\d{2})[_\-\sT]?(\d{2})?(\d{2})?(\d{2})?/;

export function dateFromName(name: string): string | null {
  const m = NAME_DATE.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31) return null;
  return `${y}:${mo}:${d} ${h ?? "00"}:${mi ?? "00"}:${s ?? "00"}`;
}

export type DateReport = {
  total: number;
  withExif: number;
  fromNameOnly: number;
  undated: string[];
  byYear: Record<string, number>;
};

export function buildDateReport(facts: ImageFacts[]): DateReport {
  const byYear: Record<string, number> = {};
  const undated: string[] = [];
  let withExif = 0;
  let fromNameOnly = 0;

  for (const f of facts) {
    let when: string | null = f.dateOriginal ?? null;
    if (when) withExif++;
    else {
      const base = f.path.split(/[\\/]/).pop() ?? f.path;
      when = dateFromName(base);
      if (when) fromNameOnly++;
      else undated.push(f.path);
    }
    const year = when?.slice(0, 4);
    if (year) byYear[year] = (byYear[year] ?? 0) + 1;
  }

  return { total: facts.length, withExif, fromNameOnly, undated, byYear };
}