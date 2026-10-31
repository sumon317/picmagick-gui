/**
 * Small typed wrapper around the local API.
 *
 * Every POST sends a JSON body — an empty object when the route has no payload
 * — because the server parses every POST body as JSON. Errors carry the server
 * message so callers can show the exact reason instead of "Failed to fetch".
 */

import { state } from "./state";

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

type ApiOptions = {
  method?: "GET" | "POST";
  body?: unknown;
  signal?: AbortSignal;
};

const VIDEO_ROUTED_PATHS = new Set([
  "config",
  "preview",
  "estimate",
  "sync",
  "sync/clean-orphans",
  "duplicates",
  "dates",
  "compare",
  "run",
  "verify",
  "manifests",
  "undo",
  "health",
]);

const VIDEO_ROUTED_PREFIXES = [
  "stream/",
  "jobs/",
  "pause/",
  "resume/",
  "cancel/",
  "job/state",
];

export function resolveApiRoute(path: string): string {
  if (state.mediaMode === "video") {
    const base = path.split("?")[0];
    if (
      VIDEO_ROUTED_PATHS.has(base) ||
      VIDEO_ROUTED_PREFIXES.some((prefix) => path.startsWith(prefix))
    ) {
      return `video/${path}`;
    }
  }
  return path;
}

export async function api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const method = opts.method ?? "GET";
  const res = await fetch("/api/" + resolveApiRoute(path), {
    method,
    headers: method === "POST" ? { "content-type": "application/json" } : undefined,
    body: method === "POST" ? JSON.stringify(opts.body ?? {}) : undefined,
    signal: opts.signal,
    cache: "no-store",
  });

  let data: unknown = {};
  try {
    data = await res.json();
  } catch {
    // A 204 or a proxy error has no JSON body; keep the status text.
  }

  if (!res.ok) {
    const message =
      typeof data === "object" && data !== null && "error" in data
        ? String((data as { error: unknown }).error)
        : res.statusText || `Request failed (${res.status})`;
    throw new ApiError(res.status, message);
  }

  return data as T;
}

/** Fetch raw bytes without the JSON wrapper (source-file / thumbnails). */
export async function apiRaw(path: string): Promise<Response> {
  return fetch("/api/" + path, { cache: "no-store" });
}
