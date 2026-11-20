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
  { key: "filesize", expr: "%B" },
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
      detached: process.platform === "linux",
      env: { ...process.env, MAGICK_THREAD_LIMIT: "1" },
    });
    const killChild = () => {
      if (process.platform === "linux" && c.pid) {
        try { process.kill(-c.pid, "SIGKILL"); return; } catch { /* ignore */ }
      }
      try { c.kill(); } catch { /* already gone */ }
    };
    const onAbort = () => {
      clearTimeout(timer);
      killChild();
    };
    const timer = setTimeout(killChild, 15_000);
    signal?.addEventListener("abort", onAbort, { once: true });

    let out = "";
    let err = "";
    c.stdout.on("data", (d) => { if (out.length < 4000) out += String(d); });
    c.stderr.on("data", (d) => { if (err.length < 2000) err += String(d); });
    c.on("error", (e) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ path: file, ok: false, error: String(e.message ?? e) });
    });
    c.on("close", (code) => {
      clearTimeout(timer);
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

/**
 * Filename dates like IMG_20240724_225458 (contiguous), 2024-07-24 (dashed
 * ISO), 2024-07-24_12-30-00 or 2024-07-24T22:54:58 are a usable fallback.
 *
 * Separators between the date groups are tolerated (dash, dot, loose space);
 * immediacy is preserved by the non-digit anchor. Time-internal separators are
 * optional so contiguous HHMMSS stems keep minutes/seconds. A 15-digit blob
 * ("123456787654321") still cannot slip through: the calendar round-trip and
 * the h/mi/s bounds below reject the resulting nonsense fields, and the year
 * floor (1970) rejects most arbitrary digit runs.
 */
const NAME_DATE =
  /(?:^|[^\d])(\d{4})(?:[._\-]?\s?)(\d{2})(?:[._\-]?\s?)(\d{2})(?:[._\-:\sT]?(\d{2})(?:[._\-:]?(\d{2})(?:[._\-:]?(\d{2}))?)?)?/;

export function dateFromName(name: string): string | null {
  const m = NAME_DATE.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const year = +y, month = +mo, day = +d;
  // Bound the year (photo filenames predate 1970), reject days that don't
  // exist (Feb 30, non-leap Feb 29) by round-tripping through UTC, and any
  // 24+/60+ time fields.
  if (year < 1970 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const real = new Date(Date.UTC(year, month - 1, day));
  if (real.getUTCFullYear() !== year || real.getUTCMonth() !== month - 1 || real.getUTCDate() !== day) return null;
  if ((h && +h > 23) || (mi && +mi > 59) || (s && +s > 59)) return null;
  return `${y}:${mo}:${d} ${h ?? "00"}:${mi ?? "00"}:${s ?? "00"}`;
}

export type DateReport = {
  total: number;
  withExif: number;
  fromNameOnly: number;
  undated: string[];
  byYear: Record<string, number>;
};

/**
 * Broken camera clocks write DateTimeOriginal like "0000:00:00 00:00:00" or
 * "2023:02:30 10:00:00". That is noise, not a year: validate the YYYY:MM:DD
 * head (real calendar day, floored at 1900) before it lands in the by-year
 * tally. The field still counts towards withExif - it IS present in the file.
 */
const EXIF_DATE_HEAD = /^(\d{4})[:\-](\d{2})[:\-](\d{2})/;
export function exifDateYear(when: string): string | null {
  const m = EXIF_DATE_HEAD.exec(when);
  if (!m) return null;
  const year = +m[1], month = +m[2], day = +m[3];
  if (year < 1900 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const real = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC(99, ...) would map to 1999 - the round-trip also catches that.
  if (real.getUTCFullYear() !== year || real.getUTCMonth() !== month - 1 || real.getUTCDate() !== day) return null;
  return m[1];
}

export function buildDateReport(facts: ImageFacts[]): DateReport {
  const byYear: Record<string, number> = {};
  const undated: string[] = [];
  let withExif = 0;
  let fromNameOnly = 0;

  for (const f of facts) {
    let when: string | null = f.dateOriginal ?? null;
    if (when) {
      withExif++;
      // Invalid EXIF year ("0000:00:00" and friends): count the field as
      // present but do NOT trust its year into the tally - skip, per M-3.
      const exifYear = exifDateYear(when);
      if (exifYear) byYear[exifYear] = (byYear[exifYear] ?? 0) + 1;
      continue;
    }
    const base = f.path.split(/[\\/]/).pop() ?? f.path;
    when = dateFromName(base);
    if (when) fromNameOnly++;
    else undated.push(f.path);
    const year = when?.slice(0, 4);
    if (year) byYear[year] = (byYear[year] ?? 0) + 1;
  }

  return { total: facts.length, withExif, fromNameOnly, undated, byYear };
}