/**
 * Run lifecycle: start, stream progress over SSE, cancel.
 */
import { EventEmitter } from "node:events";
import path from "node:path";
import type { FileResult } from "./convert.ts";
import { runConversion } from "./convert.ts";
import type { Decision, Policy } from "./policy.ts";
import { writeManifest, listManifests, readManifest, undoManifest, type Manifest } from "./manifest.ts";
import { applyProcessCpuLimitAsync, acquireSleepInhibit, releaseSleepInhibit } from "./cpu.ts";

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
  inBytes?: number;
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
  /** Last terminal SSE frame so late-attaching EventSource clients don't hang. */
  lastTerminalEvent: Progress | null = null;
  private controller = new AbortController();
  private started = 0;
  private done = 0;
  private inFlight = 0;
  private totals = { converted: 0, copied: 0, skipped: 0, failed: 0, bytes: 0, inBytes: 0 };
  private sleepHeld = false;

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
  /** Live runPool's dispatch hook; raising the limit starts new work at once. */
  private wakeDispatch: (() => void) | null = null;

  /** Change concurrency on a running job. Clamped to something sane. */
  setJobs(n: number) {
    this.liveJobs = Math.max(1, Math.min(Math.round(n) || 1, 32));
    this.wakeDispatch?.();
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
    const pids = [...this.activePids];
    if (pids.length > 0) {
      // Build every per-PID affinity update up front, then coalesce them so a
      // slow/hung taskset on one PID never serializes the others or blocks the
      // event loop. setCpuLimit stays synchronous because server.ts reads its
      // numeric return immediately; the bounded waits run in the background.
      void Promise.all(
        pids.map((pid) => applyProcessCpuLimitAsync(pid, this.liveCpuLimit)),
      ).catch((err) => console.warn(`[jobs] CPU limit update failed:`, err));
    }
    return this.liveCpuLimit;
  }

  getCpuLimitValue() {
    return this.liveCpuLimit;
  }

  private totalElapsedSeconds(): number {
    const activeMs = this.state === "running" && this.started > 0 ? Date.now() - this.started : 0;
    return (this.elapsedBeforePauseMs + activeMs) / 1000;
  }

  private emitProgress(file?: FileResult, starting?: { rel: string; bytes: number }) {
    const elapsed = this.totalElapsedSeconds();
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
      inBytes: this.totals.inBytes,
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
    this.totals = { converted: 0, copied: 0, skipped: 0, failed: 0, bytes: 0, inBytes: 0 };
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
      inBytes: this.totals.inBytes,
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

  /**
   * Write one manifest covering everything this job has put on disk so far.
   * Returns the id (undefined when nothing landed). Entries carry
   * converted/copied rows only, so a partial run's manifest never claims
   * more than actually landed.
   */
  private async persistResultsManifest(o: StartOptions): Promise<string | undefined> {
    if (this.results.length === 0) return undefined;
    const id =
      `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 6)}`;
    await writeManifest(
      o.destination,
      id,
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
    return id;
  }

  /** Hard stop: kills in-flight encoders. Partial outputs are cleaned up. */
  async cancel(): Promise<boolean> {
    if (this.sleepHeld) {
      releaseSleepInhibit();
      this.sleepHeld = false;
    }
    // A paused job has nothing in flight, so cancelling is a state change —
    // but the paused segment's finished files are already on disk and still
    // need a manifest, or they become permanently non-undoable.
    if (this.state === "paused") {
      this.state = "cancelled";
      const manifestId = await this.persistResultsManifest(this.opts!).catch(() => undefined);
      const finishEvt: Progress = {
        type: "finish",
        at: Date.now(),
        jobId: this.id,
        manifestId,
        summary: this.summary(this.totals.bytes, "cancelled"),
        message: manifestId
          ? "Paused run discarded. Completed files are on disk (undoable) and will be skipped next time."
          : "Paused run discarded. Completed files are on disk and will be skipped next time.",
      };
      this.lastTerminalEvent = finishEvt;
      this.emit("progress", finishEvt);
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
      inBytes: this.totals.inBytes,
      remaining: this.total - this.done,
      elapsedSeconds: Math.round(this.totalElapsedSeconds()),
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

    if (!this.sleepHeld) {
      acquireSleepInhibit();
      this.sleepHeld = true;
    }

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
        onWake: (wake) => { this.wakeDispatch = wake; },
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
          if (r.status !== "cancelled") {
            this.finished.add(r.rel);
            this.totals.bytes += r.outBytes;
            this.totals.inBytes += r.inBytes;
            this.done++;
            this.totals[r.status === "converted" ? "converted"
              : r.status === "copied" ? "copied"
              : r.status === "skipped" ? "skipped"
              : "failed"]++;
          }
          this.emitProgress(r);
        },
      }, this.shouldStop);
      this.wakeDispatch = null; // pool over: a later setJobs() must not wake it

      // A pause is not a finished run, so no manifest is written yet.
      if (this.pauseRequested && !this.controller.signal.aborted && this.done < this.total) {
        if (this.started > 0) {
          this.elapsedBeforePauseMs += Date.now() - this.started;
          this.started = 0;
        }
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

      if (this.started > 0) {
        this.elapsedBeforePauseMs += Date.now() - this.started;
        this.started = 0;
      }

      const cancelled = this.controller.signal.aborted;
      this.state = cancelled ? "cancelled" : "done";
      this.results = [...this.results, ...result.results];

      // Every file this job finished gets a manifest — including on a
      // cancelled run, where previously the completed files were stranded in
      // the destination with no undo record (JB-1).
      // Same guard as the paused/cancel branch: a manifest write failure must
      // not turn an otherwise finished job into a "failed" state + error event.
      const manifestId = await this.persistResultsManifest(o).catch(() => undefined);

      const finishEvt: Progress = {
        type: "finish",
        at: Date.now(),
        jobId: this.id,
        manifestId,
        summary: this.summary(
          this.totals.bytes,
          cancelled
            ? "cancelled"
            : this.done > 0 && this.totals.failed === this.done
              ? "every file failed — check the ImageMagick panel"
              : undefined,
        ),
      };
      this.lastTerminalEvent = finishEvt;
      this.emit("progress", finishEvt);
    } catch (err) {
      this.wakeDispatch = null;
      this.state = "failed";
      const errEvt: Progress = {
        type: "error", at: Date.now(), jobId: this.id,
        message: (err as Error).message,
      };
      this.lastTerminalEvent = errEvt;
      this.emit("progress", errEvt);
    } finally {
      if (this.sleepHeld && this.state !== "running") {
        releaseSleepInhibit();
        this.sleepHeld = false;
      }
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
    const oldest = [...jobs.values()].find((j) => j.state !== "running" && j.state !== "paused");
    if (oldest) jobs.delete(oldest.id);
  }
  return job;
}

export async function manifestsFor(destination: string): Promise<Manifest[]> {
  const files = await listManifests(destination);
  const out: Manifest[] = [];
  for (const f of files) {
    try { out.push(await readManifest(path.join(destination, f))); } catch { /* unreadable */ }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export { undoManifest };
