/**
 * Persistent user workspace configuration stored in DATA_ROOT/.compakta-settings.json.
 *
 * Restores the user's last source folder, destination, budget, and photo/video
 * recipes on startup unless overridden by environment variables.
 *
 * The file is user-editable (and can corrupt), so a restored value is never
 * trusted on its declared type alone: everything passes through
 * sanitizePersisted(), which keeps only whitelisted fields that actually
 * match their declared shape. A poisoned file degrades to defaults instead of
 * feeding NaN/garbage into budget math or policy merges.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { DATA_ROOT } from "./appdirs.ts";
import type { Policy } from "./policy.ts";
import type { VideoPolicy } from "./video/policy.ts";

const SETTINGS_FILE = path.join(DATA_ROOT, ".compakta-settings.json");

export type PersistedSettings = {
  sourceRoot?: string;
  destination?: string;
  budgetBytes?: number;
  policy?: Partial<Policy>;
  videoPolicy?: Partial<VideoPolicy>;
  videoCustomDestination?: string;
  recentSources?: string[];
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const cleanPath = (v: unknown): string | undefined => {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (!t || t.length > 1024) return undefined;
  return t;
};

/** Same shape the POST path expects: finite, > 0 (server.ts validates
 * budgetBytes exactly like this on config updates). */
const cleanBudget = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v > 0 && v <= Number.MAX_SAFE_INTEGER
    ? v
    : undefined;

const cleanStringList = (v: unknown): string[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const out = [...new Set(v.filter((s): s is string => typeof s === "string" && s.trim().length > 0 && s.length <= 1024))];
  return out.length > 0 ? out.slice(0, 200) : undefined;
};

/**
 * Upper bound for list-valued policy fields (excludedFolders, includedFiles,
 * qualities, ...). Kept deliberately high so a large exclusion set survives a
 * save; entries past the cap are trimmed element-wise with a warning instead
 * of dropping the entire field (MED-4).
 */
const MAX_POLICY_ARRAY = 10_000;

/** Partial-policy shape check: only fields whose declared type matches are
 * carried; scalar garbage is dropped. Consumers still run their own
 * normalisers (normalisePolicy / normaliseVideoPolicy) on top. */
const cleanPolicyPartial = (v: unknown): Record<string, unknown> | undefined => {
  if (!isPlainObject(v)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === "string" && val.length <= 1024) { out[k] = val; continue; }
    if (typeof val === "boolean") { out[k] = val; continue; }
    if (typeof val === "number" && Number.isFinite(val) && Math.abs(val) <= Number.MAX_SAFE_INTEGER) { out[k] = val; continue; }
    if (Array.isArray(val)) {
      // Keep the whitelist (string[] / number[]) but sanitise element-wise:
      // one stray bad entry or an oversized list must never erase the whole
      // field. That used to silently lose every persisted exclusion above
      // 500 entries on the next save. Prefer the dominant declared primitive
      // so a single wrong-typed item cannot flip a string list to numbers.
      const strings = val.filter((s): s is string => typeof s === "string");
      const nums = val.filter((n): n is number => typeof n === "number" && Number.isFinite(n));
      const useStrings = strings.length > 0 && strings.length >= nums.length;
      const picked = useStrings ? strings : nums;
      if (picked.length === 0) continue; // arrays with no usable entries are dropped
      const kept = picked.slice(0, MAX_POLICY_ARRAY);
      if (picked.length !== val.length || kept.length !== picked.length) {
        console.warn(
          `[settings] policy.${k}: trimmed ${useStrings ? "string" : "number"} array ` +
          `from ${val.length} to ${kept.length} entries`,
        );
      }
      out[k] = kept;
      continue;
    }
    if (isPlainObject(val)) {
      // The only 2-depth field either policy type declares is extEnabled:
      // Record<string, boolean>. A truthy string like "no" would survive into
      // normalisePolicy (`extEnabled[ext] = base.extEnabled?.[ext] ?? true`)
      // and read back as ENABLED, so keep only real booleans. Non-bool entries
      // are dropped per key instead of rejecting the whole map: one corrupted
      // key must not wipe the user's legitimate per-extension choices
      // ("absent" == the same safe default-on the normaliser applies).
      const inner: Record<string, unknown> = {};
      for (const [ik, iv] of Object.entries(val)) {
        if (typeof iv === "boolean") inner[ik] = iv;
      }
      if (Object.keys(inner).length > 0 && Object.keys(inner).length <= 500) { out[k] = inner; continue; }
    }
    // anything else (null, nested arrays, functions) is dropped
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

/** Exported for the integration probes and potential POST-path reuse:
 * one call is the whole "never trust the raw file" guarantee. */
export function sanitizePersisted(raw: unknown): PersistedSettings {
  if (!isPlainObject(raw)) return {};
  const out: PersistedSettings = {};
  const sourceRoot = cleanPath(raw.sourceRoot);
  if (sourceRoot) out.sourceRoot = sourceRoot;
  const destination = cleanPath(raw.destination);
  if (destination) out.destination = destination;
  const videoCustomDestination = cleanPath(raw.videoCustomDestination);
  if (videoCustomDestination) out.videoCustomDestination = videoCustomDestination;
  const budgetBytes = cleanBudget(raw.budgetBytes);
  if (budgetBytes !== undefined) out.budgetBytes = budgetBytes;
  const recentSources = cleanStringList(raw.recentSources);
  if (recentSources) out.recentSources = recentSources;
  const policy = cleanPolicyPartial(raw.policy);
  if (policy) out.policy = policy as Partial<Policy>;
  const videoPolicy = cleanPolicyPartial(raw.videoPolicy);
  if (videoPolicy) out.videoPolicy = videoPolicy as Partial<VideoPolicy>;
  return out;
}

let currentSettings: PersistedSettings | null = null;

export function loadPersistedSettings(): PersistedSettings {
  if (currentSettings) return currentSettings;
  try {
    if (existsSync(SETTINGS_FILE)) {
      const parsed: unknown = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
      currentSettings = sanitizePersisted(parsed);
      return { ...currentSettings };
    }
  } catch {
    /* ignore unreadable or corrupt settings file - defaults apply */
  }
  currentSettings = {};
  return {};
}

export function savePersistedSettings(patch: Partial<PersistedSettings>): void {
  const prev = loadPersistedSettings();
  // Saved data goes through the same sanitizer so a malformed patch can never
  // reach disk and come back as poison on the next boot.
  currentSettings = sanitizePersisted({ ...prev, ...patch });
  const tmpFile = `${SETTINGS_FILE}.tmp-${process.pid}`;
  try {
    mkdirSync(DATA_ROOT, { recursive: true });
    writeFileSync(tmpFile, JSON.stringify(currentSettings, null, 2), "utf8");
    renameSync(tmpFile, SETTINGS_FILE);
  } catch {
    try { rmSync(tmpFile, { force: true }); } catch { /* ignore */ }
    /* ignore write failures in read-only environments */
  }
}

export function recordRecentSource(sourceRoot: string): void {
  if (!sourceRoot || typeof sourceRoot !== "string") return;
  const trimmed = sourceRoot.trim();
  if (!trimmed) return;
  const settings = loadPersistedSettings();
  const existing = (settings.recentSources ?? []).filter((s) => s !== trimmed);
  const updated = [trimmed, ...existing].slice(0, 10);
  savePersistedSettings({ recentSources: updated });
}
