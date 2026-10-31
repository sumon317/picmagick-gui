/**
 * ImageMagick version parsing, shared by portable-folder discovery and the
 * GitHub update check. Release tags look like "7.1.2-34", and the same string
 * is embedded in both `magick -version` output and the portable folder name.
 */

/** [major, minor, patch, build]. A plain "7.1.2" has build 0. */
export type VersionTuple = [number, number, number, number];

export const APP_VERSION = "1.3.2";

export function parseVersion(text: string): VersionTuple | null {
  const m = /(\d+)\.(\d+)\.(\d+)(?:[-._](\d+))?/.exec(text);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 0)];
}

/** Negative when `a` is older, positive when `a` is newer, 0 when equal. */
export function compareVersions(a: string | VersionTuple, b: string | VersionTuple): number {
  const pa = typeof a === "string" ? parseVersion(a) : a;
  const pb = typeof b === "string" ? parseVersion(b) : b;
  if (!pa || !pb) return 0;
  for (let i = 0; i < 4; i++) {
    if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  }
  return 0;
}

/** True when `candidate` is a later release than `current` (or nothing is installed). */
export function isNewerVersion(candidate: string, current: string | null | undefined): boolean {
  if (!current) return true;
  if (!parseVersion(current)) return true;
  return compareVersions(candidate, current) > 0;
}
