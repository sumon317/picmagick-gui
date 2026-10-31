/**
 * Persistent user workspace configuration stored in DATA_ROOT/.compakta-settings.json.
 *
 * Restores the user's last source folder, destination, budget, and photo/video
 * recipes on startup unless overridden by environment variables.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
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
};

let currentSettings: PersistedSettings | null = null;

export function loadPersistedSettings(): PersistedSettings {
  if (currentSettings) return currentSettings;
  try {
    if (existsSync(SETTINGS_FILE)) {
      const parsed = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
      if (parsed && typeof parsed === "object") {
        currentSettings = parsed as PersistedSettings;
        return currentSettings;
      }
    }
  } catch {
    /* ignore unreadable settings file */
  }
  currentSettings = {};
  return currentSettings;
}

export function savePersistedSettings(patch: Partial<PersistedSettings>): void {
  const prev = loadPersistedSettings();
  currentSettings = { ...prev, ...patch };
  try {
    mkdirSync(DATA_ROOT, { recursive: true });
    writeFileSync(SETTINGS_FILE, JSON.stringify(currentSettings, null, 2), "utf8");
  } catch {
    /* ignore write failures in read-only environments */
  }
}
