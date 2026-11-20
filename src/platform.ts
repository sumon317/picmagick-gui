/**
 * The handful of OS differences that leak into path handling.
 *
 * Relative paths stay native: `a\b` on Windows, `a/b` on Linux. That keeps
 * every existing Windows value byte-for-byte identical while giving the Linux
 * side a separator it can rely on. The browser receives both values through
 * `/api/status` instead of guessing from the string.
 */

export const IS_WINDOWS = process.platform === "win32";
export const IS_LINUX = process.platform === "linux";
export const IS_MACOS = process.platform === "darwin";

/** Windows and (default) macOS volumes compare case-insensitively; Linux paths do not. */
export const CASE_INSENSITIVE = IS_WINDOWS || IS_MACOS;

/** Native separator for values in `ScannedFile.rel` and `dir`. */
export const REL_SEP = IS_WINDOWS ? "\\" : "/";

/** The binary name looked up on PATH. */
export const MAGICK_BIN = IS_WINDOWS ? "magick.exe" : "magick";

/** Normalise a path for comparison without changing its meaning. */
export const pathKey = (p: string): string => CASE_INSENSITIVE ? p.toLowerCase() : p;

/** First component of a native relative path. */
export function relTop(rel: string, sep = REL_SEP): string {
  return rel.split(sep)[0] ?? rel;
}

/** True when `rel` is at or below `prefix`, matching on a path boundary. */
export function relIsUnder(rel: string, prefix: string, sep = REL_SEP): boolean {
  return rel === prefix || rel.startsWith(prefix + sep);
}
