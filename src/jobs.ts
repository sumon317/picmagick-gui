/**
 * Run lifecycle: start, stream progress over SSE, cancel.
 */
import { EventEmitter } from "node:events";
import type { FileResult } from "./convert.ts";
import { runConversion } from "./convert.ts";
import type { Decision, Policy } from "./policy.ts";
import { writeManifest, listManifests, readManifest, undoManifest, type Manifest } from "./manifest.ts";
import { applyProcessCpuLimit } from "./cpu.ts";

export type JobState = "idle" | "running" | "paused" | "done" | "cancelled" | "failed";

export type Progress = {
  type: "start" | "progress" | "log" | "finish" | "error" | "paused" | "resumed";
  at: number;
  total?: number;
  jobId?: string;
  done?: number;
  converted?: number;
  copied?: number;
  skipped?: number;
  failed?: number;
  bytes?: number;
  etaSeconds?: number;
  elapsedSeconds?: number;
  file?: FileResult;
  starting?: { rel: string; bytes: number };
  /** Files currently inside the encoder. */
  inFlight?: number;
  cpuLimit?: number;
  summary?: Record<string, unknown>;
  message?: string;
  manifestId?: string;
  /** Remaining after a pause. */
  remaining?: number;
  /** Free-form note attached to a terminal event. */
  note?: string;
};

export type StartOptions = {
  decisions: Decision[];
  sourceRoot: string;
  destination: string;
  magickPath: string;
  policy: Policy;
  jobs: number;
  cpuLimit?: number;
  overwrite: boolean;
  qualityLabel: number[];
};

export class Job extends EventEmitter {
  readonly id: string;
  state: JobState = "idle";
  /** Retained so verification can re-open exactly what this run produced. */
  results: FileResult[] = [];
  private controller = new AbortController();
  private started = 0;
  private done = 0;
  private inFlight = 0;
  private totals = { converted: 0, copied: 0, skipped: 0, failed: 0, bytes: 0 };

  // ── pause / resume ──
  private pauseRequested = false;
  /** Everything this job was asked to do, kept so a resume knows the full set. */
  private queue: Decision[] = [];
  /** rel paths already finished, so a resume never redoes them. */
  private finished = new Set<string>();
  /** Cumulative across pauses, so the UI can show overall progress. */
  private runStartDone = 0;
  private runStartTotal = 0;

  constructor(id: string) {
    super();
    // Many browser tabs may stream the same job.
    this.setMaxListeners(200);
    this.id = id;
  }

  /** True when the pool should stop handing out new work. */
  private shouldStop = () => this.pauseRequested || this.controller.signal.aborted;

  /**
   * Current parallel-job count, readable mid-run.
   *
   * The pool consults this before every dispatch, so moving the slider takes
   * effect on the next file rather than at the next run.
   */
  private liveJobs = 1;
  private getLimit = () => this.liveJobs;

  /** Change concurrency on a running job. Clamped to something sane. */
  setJobs(n: number) {
    this.liveJobs = Math.max(1, Math.min(Math.round(n) || 1, 32));
    return this.liveJobs;
  }

  getJobs() {
    return this.liveJobs;
  }

  /**
   * Current CPU limit percentage (10 - 100).
   *
   * Changing this immediately adjusts processor affinity on all in-flight
   * encoders and applies to upcoming dispatches.
   */
  private liveCpuLimit = 70;
  private activePids = new Set<number>();
  private elapsedBeforePauseMs = 0;
  private getCpuLimit = () => this.liveCpuLimit;

  setCpuLimit(n: number) {
    this.liveCpuLimit = Math.max(10, Math.min(Math.round(n) || 70, 100));
    for (const pid of this.activePids) {
      applyProcessCpuLimit(pid, this.liveCpuLimit);
    }
    return this.liveCpuLimit;
  }

  getCpuLimitValue() {
    return this.liveCpuLimit;
  }

  private emitProgress(file?: FileResult, starting?: { rel: string; bytes: number }) {
    const elapsed = (this.elapsedBeforePauseMs + (Date.now() - this.started)) / 1000;
    // Average service time across finished files, scaled by remaining work.
    const avg = this.done > 0 ? elapsed / this.done : 0;
    const remaining = Math.max(0, this.total - this.done);
    this.emit("progress", {
      type: "progress",
      at: Date.now(),
      done: this.done,
      total: this.total,
      converted: this.totals.converted,
      copied: this.totals.copied,
      skipped: this.totals.skipped,
      failed: this.totals.failed,
      bytes: this.totals.bytes,
      elapsedSeconds: elapsed,
      etaSeconds: Math.round(remaining * avg),
      file,
      // Emitted the instant a file enters the encoder. A single AV1 encode can
      // run for many seconds, and without this the bar looks frozen.
      starting: starting ? { rel: starting.rel, bytes: starting.bytes } : undefined,
      inFlight: this.inFlight,
    } satisfies Progress);
  }

private total = 0;
  /** Options retained so resume() needs nothing from the caller. */
  private opts: StartOptions | null = null;

  async start(opts: StartOptions) {
    this.opts = opts;
    this.queue = opts.decisions;
    this.liveJobs = Math.max(1, Math.min(opts.jobs, 32));
    this.liveCpuLimit = Math.max(10, Math.min(opts.cpuLimit ?? 70, 100));
    this.activePids.clear();
    this.finished = new Set();
    this.done = 0;
    this.totals = { converted: 0, copied: 0, skipped: 0, failed: 0, bytes: 0 };
    this.total = opts.decisions.length;
    return this.execute(opts.decisions, false);
  }

  /**
   * Continue from where the pause left off.
   *
   * Everything already recorded in `finished` is dropped, so no file is
   * converted twice. This is in addition to the skip-if-output-exists check
   * inside the converter, which is what protects against a process restart
   * losing this set.
   */
  async resume() {
    if (!this.opts) throw new Error("Nothing to resume.");
    if (this.state === "running") throw new Error("Already running.");
    if (this.state !== "paused") throw new Error(`Cannot resume from "${this.state}".`);

    const remaining = this.queue.filter((d) => !this.finished.has(d.file.rel));
    this.pauseRequested = false;
    return this.execute(remaining, true);
  }

  /** Snapshot for the UI, and for resuming after a page refresh. */
  progress() {
    return {
      state: this.state,
      done: this.done,
      total: this.total,
      remaining: Math.max(0, this.total - this.done),
      converted: this.totals.converted,
      copied: this.totals.copied,
      skipped: this.totals.skipped,
      failed: this.totals.failed,
      bytes: this.totals.bytes,
      jobs: this.liveJobs,
      cpuLimit: this.liveCpuLimit,
      inFlight: this.inFlight,
    };
  }

  /** Graceful: stop handing out work, let in-flight encodes finish and land. */
  pause() {
    if (this.state !== "running") return false;
    this.pauseRequested = true;
    return true;
  }

  /** Hard stop: kills in-flight encoders. Partial outputs are cleaned up. */
  cancel() {
    // A paused job has nothing in flight, so cancelling is just a state change.
    // It still has to be handled: otherwise a paused run could never be
    // abandoned and the UI's "Cancel instead" would silently do nothing.
    if (this.state === "paused") {
      this.state = "cancelled";
      this.emit("progress", {
        type: "finish",
        at: Date.now(),
        jobId: this.id,
        manifestId: undefined,
        summary: this.summary(this.totals.bytes, "cancelled"),
        message: "Paused run discarded. Completed files are on disk and will be skipped next time.",
      } satisfies Progress);
      return true;
    }
    if (this.state !== "running") return false;
    this.controller.abort();
    return true;
  }

  private summary(bytes: number, note?: string) {
    return {
      total: this.total,
      done: this.done,
      converted: this.totals.converted,
      copied: this.totals.copied,
      skipped: this.totals.skipped,
      failed: this.totals.failed,
      bytes,
      remaining: this.total - this.done,
      elapsedSeconds: Math.round((this.elapsedBeforePauseMs + (Date.now() - this.started)) / 1000),
      note,
    };
  }

  private async execute(decisions: Decision[], resuming: boolean) {
    this.state = "running";
    if (!resuming) {
      this.elapsedBeforePauseMs = 0;
    }
    this.started = Date.now();
    this.controller = new AbortController();
    const o = this.opts!;

    this.emit("progress", {
      type: resuming ? "resumed" : "start",
      at: Date.now(),
      total: this.total,
      done: this.done,
      jobId: this.id,
      message: resuming
        ? `Resuming: ${decisions.length.toLocaleString()} of ${this.total.toLocaleString()} left`
        : undefined,
    } satisfies Progress);

    try {
      const result = await runConversion(decisions, {
        sourceRoot: o.sourceRoot,
        destination: o.destination,
        magickPath: o.magickPath,
        policy: o.policy,
        jobs: o.jobs,
        cpuLimit: this.liveCpuLimit,
        getLimit: this.getLimit,
        getCpuLimit: this.getCpuLimit,
        onChildSpawn: (pid) => this.activePids.add(pid),
        onChildExit: (pid) => this.activePids.delete(pid),
        overwrite: o.overwrite,
        signal: this.controller.signal,
        onStart: (rel, bytes) => {
          this.inFlight++;
          this.emitProgress(undefined, { rel, bytes });
        },
        onResult: (r) => {
          this.inFlight--;
          this.done++;
          this.finished.add(r.rel);
          this.totals.bytes += r.outBytes;
          this.totals[r.status === "converted" ? "converted"
            : r.status === "copied" ? "copied"
            : r.status === "skipped" ? "skipped"
            : "failed"]++;
          this.emitProgress(r);
        },
      }, this.shouldStop);

      // A pause is not a finished run, so no manifest is written yet.
      if (this.pauseRequested && !this.controller.signal.aborted) {
        this.elapsedBeforePauseMs += Date.now() - this.started;
        this.state = "paused";
        this.results = [...this.results, ...result.results];
        this.emit("progress", {
          type: "paused",
          at: Date.now(),
          jobId: this.id,
          done: this.done,
          total: this.total,
          remaining: this.total - this.done,
          message:
            `Paused with ${(this.total - this.done).toLocaleString()} files left. ` +
            `Resume picks up from here.`,
        } satisfies Progress);
        return;
      }

      const cancelled = this.controller.signal.aborted;
      this.state = cancelled ? "cancelled" : "done";
      this.results = [...this.results, ...result.results];

      let manifestId: string | undefined;
      if (!cancelled) {
        manifestId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
        await writeManifest(
          o.destination,
          manifestId,
          {
            createdAt: Date.now(),
            sourceRoot: o.sourceRoot,
            destination: o.destination,
            quality: o.qualityLabel,
            heicSpeed: o.policy.heicSpeed,
            outputFormat: o.policy.outputFormat,
            tool: "compakta",
          },
          this.results,
        );
      }

      this.emit("progress", {
        type: "finish",
        at: Date.now(),
        jobId: this.id,
        manifestId,
        summary: this.summary(this.totals.bytes, cancelled ? "cancelled" : undefined),
      } satisfies Progress);
    } catch (err) {
      this.state = "failed";
      this.emit("progress", {
        type: "error", at: Date.now(), jobId: this.id,
        message: (err as Error).message,
      } satisfies Progress);
    }
  }
}

const jobs = new Map<string, Job>();

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function activeJob(): Job | undefined {
  for (const j of jobs.values()) if (j.state === "running") return j;
  return undefined;
}

/** A paused job is still resumable, so it must block a fresh run. */
export function liveJob(): Job | undefined {
  for (const j of jobs.values()) {
    if (j.state === "running" || j.state === "paused") return j;
  }
  return undefined;
}

export function pausedJob(): Job | undefined {
  for (const j of jobs.values()) if (j.state === "paused") return j;
  return undefined;
}

export function newJob(): Job {
  const job = new Job(`job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`);
  jobs.set(job.id, job);
  // Keep the map from growing without bound over a long session.
  if (jobs.size > 40) {
    const oldest = [...jobs.values()].find((j) => j.state !== "running");
    if (oldest) jobs.delete(oldest.id);
  }
  return job;
}

export async function manifestsFor(destination: string): Promise<Manifest[]> {
  const files = await listManifests(destination);
  const out: Manifest[] = [];
  for (const f of files) {
    try { out.push(await readManifest(`${destination}/${f}`)); } catch { /* unreadable */ }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export { undoManifest };
