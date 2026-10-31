/**
 * Video job lifecycle: start, stream intra-file + overall progress over SSE,
 * instant OS-level pause/resume/cancel, and undoable manifest writing.
 */
import { EventEmitter } from "node:events";
import type { FileResult } from "../convert.ts";
import { applyProcessCpuLimit, resumeProcess, suspendProcess } from "../cpu.ts";
import type { OutputFormat } from "../formats.ts";
import type { JobState, Progress } from "../jobs.ts";
import { writeManifest } from "../manifest.ts";
import {
  runVideoConversion,
  type IntraFileProgress,
} from "./convert.ts";
import type { FfmpegInfo } from "./ffmpeg.ts";
import type { VideoDecision, VideoPolicy } from "./policy.ts";

// --------------------------------------------------------------------------
// OS Process Suspend / Resume for instant mid-video pause
// --------------------------------------------------------------------------

export type VideoStartOptions = {
  decisions: VideoDecision[];
  sourceRoot: string;
  effectiveDestination: string;
  ffmpeg: FfmpegInfo;
  policy: VideoPolicy;
  jobs: number;
  cpuLimit?: number;
  overwrite: boolean;
};

export class VideoJob extends EventEmitter {
  readonly id: string;
  state: JobState = "idle";
  results: FileResult[] = [];
  private controller = new AbortController();
  private started = 0;
  private elapsedBeforePauseMs = 0;
  private done = 0;
  private total = 0;
  private inFlight = 0;
  private totals = { converted: 0, copied: 0, skipped: 0, failed: 0, bytes: 0 };

  private pauseRequested = false;
  private osSuspended = false;
  private queue: VideoDecision[] = [];
  private finished = new Set<string>();
  private opts: VideoStartOptions | null = null;

  private liveJobs = 1;
  private getLimit = () => this.liveJobs;

  private liveCpuLimit = 70;
  private activePids = new Set<number>();
  private getCpuLimit = () => this.liveCpuLimit;

  constructor(id: string) {
    super();
    this.setMaxListeners(200);
    this.id = id;
  }

  private shouldStop = () => this.pauseRequested || this.controller.signal.aborted;

  private totalElapsedSeconds(): number {
    const activeMs = this.state === "running" && this.started > 0 ? Date.now() - this.started : 0;
    return (this.elapsedBeforePauseMs + activeMs) / 1000;
  }

  setJobs(n: number) {
    this.liveJobs = Math.max(1, Math.min(Math.round(n) || 1, 8));
    return this.liveJobs;
  }

  setCpuLimit(n: number) {
    this.liveCpuLimit = Math.max(10, Math.min(Math.round(n) || 70, 100));
    for (const pid of this.activePids) {
      applyProcessCpuLimit(pid, this.liveCpuLimit);
    }
    return this.liveCpuLimit;
  }

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

  private emitProgress(
    file?: FileResult,
    starting?: { rel: string; bytes: number },
    intra?: IntraFileProgress,
  ) {
    if (this.osSuspended) return;
    const elapsed = this.totalElapsedSeconds();
    const effectiveDone = this.done + (intra ? intra.percent / 100 : 0);
    const avg = effectiveDone > 0.05 ? elapsed / effectiveDone : 0;
    const remaining = Math.max(0, this.total - effectiveDone);

    const statusMessage = intra
      ? `Encoding ${intra.rel} (${intra.percent}%${intra.fps > 0 ? ` · ${intra.fps.toFixed(0)} fps` : ""}${intra.speed ? ` · ${intra.speed}` : ""})`
      : undefined;

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
      etaSeconds: avg > 0 ? Math.round(remaining * avg) : undefined,
      file,
      starting: starting
        ? { rel: starting.rel, bytes: starting.bytes }
        : intra
          ? { rel: `${intra.rel} (${intra.percent}%)`, bytes: intra.outBytes }
          : undefined,
      inFlight: this.inFlight,
      message: statusMessage,
    } satisfies Progress);
  }

  async start(opts: VideoStartOptions) {
    this.opts = opts;
    this.queue = opts.decisions;
    this.liveJobs = Math.max(1, Math.min(opts.jobs, 8));
    this.liveCpuLimit = Math.max(10, Math.min(opts.cpuLimit ?? 70, 100));
    this.activePids.clear();
    this.finished = new Set();
    this.done = 0;
    this.elapsedBeforePauseMs = 0;
    this.osSuspended = false;
    this.totals = { converted: 0, copied: 0, skipped: 0, failed: 0, bytes: 0 };
    this.total = opts.decisions.length;
    return this.execute(opts.decisions, false);
  }

  async resume() {
    if (!this.opts) throw new Error("Nothing to resume.");
    if (this.state === "running") throw new Error("Already running.");
    if (this.state !== "paused") throw new Error(`Cannot resume from "${this.state}".`);

    // If in-flight FFmpeg processes were OS-suspended, wake them up immediately
    if (this.osSuspended && this.activePids.size > 0) {
      for (const pid of this.activePids) {
        resumeProcess(pid);
      }
      this.osSuspended = false;
      this.pauseRequested = false;
      this.started = Date.now();
      this.state = "running";
      this.emit("progress", {
        type: "resumed",
        at: Date.now(),
        total: this.total,
        done: this.done,
        jobId: this.id,
        message: `Resumed mid-video encode (${(this.total - this.done).toLocaleString()} left)`,
      } satisfies Progress);
      return;
    }

    const remaining = this.queue.filter((d) => !this.finished.has(d.file.rel));
    this.pauseRequested = false;
    this.osSuspended = false;
    return this.execute(remaining, true);
  }

  /**
   * Freezes active FFmpeg processes immediately via OS suspend (dropping CPU to 0%
   * in <1ms) while also setting pauseRequested so no new files are dispatched.
   */
  pause() {
    if (this.state !== "running") return false;
    this.pauseRequested = true;
    this.elapsedBeforePauseMs += Date.now() - this.started;
    this.started = 0;

    let anySuspended = false;
    for (const pid of this.activePids) {
      if (suspendProcess(pid)) {
        anySuspended = true;
      }
    }

    if (anySuspended) {
      this.osSuspended = true;
      this.state = "paused";
      this.emit("progress", {
        type: "paused",
        at: Date.now(),
        jobId: this.id,
        done: this.done,
        total: this.total,
        remaining: this.total - this.done,
        message: `Paused immediately (CPU freed). Resume continues from the exact same frame.`,
      } satisfies Progress);
    }
    return true;
  }

  cancel() {
    // Wake any suspended processes before aborting so they can exit and clean up .part files
    if (this.osSuspended) {
      for (const pid of this.activePids) {
        resumeProcess(pid);
      }
      this.osSuspended = false;
    }

    if (this.state === "paused" && this.activePids.size === 0) {
      this.state = "cancelled";
      this.emit("progress", {
        type: "finish",
        at: Date.now(),
        jobId: this.id,
        manifestId: undefined,
        summary: this.summary(this.totals.bytes, "cancelled"),
        message: "Paused video run discarded. Completed files remain on disk.",
      } satisfies Progress);
      return true;
    }

    if (this.state !== "running" && this.state !== "paused") return false;
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
      elapsedSeconds: Math.round(this.totalElapsedSeconds()),
      note,
    };
  }

  private async execute(decisions: VideoDecision[], resuming: boolean) {
    this.state = "running";
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
        ? `Resuming: ${decisions.length.toLocaleString()} of ${this.total.toLocaleString()} videos left`
        : undefined,
    } satisfies Progress);

    try {
      const result = await runVideoConversion(
        decisions,
        {
          sourceRoot: o.sourceRoot,
          effectiveDestination: o.effectiveDestination,
          ffmpeg: o.ffmpeg,
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
          onFileProgress: (intra) => {
            this.emitProgress(undefined, undefined, intra);
          },
          onResult: (r) => {
            this.inFlight--;
            this.done++;
            this.finished.add(r.rel);
            this.totals.bytes += r.outBytes;
            this.totals[
              r.status === "converted"
                ? "converted"
                : r.status === "copied"
                  ? "copied"
                  : r.status === "skipped"
                    ? "skipped"
                    : "failed"
            ]++;
            this.emitProgress(r);
          },
        },
        this.shouldStop,
      );

      if (this.pauseRequested && !this.controller.signal.aborted) {
        this.state = "paused";
        this.results = [...this.results, ...result.results];
        this.emit("progress", {
          type: "paused",
          at: Date.now(),
          jobId: this.id,
          done: this.done,
          total: this.total,
          remaining: this.total - this.done,
          message: `Paused with ${(this.total - this.done).toLocaleString()} videos left. Resume picks up from here.`,
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

      let manifestId: string | undefined;
      if (!cancelled) {
        manifestId = `video-run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
        await writeManifest(
          o.effectiveDestination,
          manifestId,
          {
            createdAt: Date.now(),
            sourceRoot: o.sourceRoot,
            destination: o.effectiveDestination,
            quality: [o.policy.quality],
            heicSpeed: o.policy.speed,
            outputFormat: o.policy.outputFormat as unknown as OutputFormat,
            tool: "compakta-video",
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
        type: "error",
        at: Date.now(),
        jobId: this.id,
        message: (err as Error).message,
      } satisfies Progress);
    }
  }
}

const videoJobs = new Map<string, VideoJob>();

export function getVideoJob(id: string): VideoJob | undefined {
  return videoJobs.get(id);
}

export function liveVideoJob(): VideoJob | undefined {
  for (const j of videoJobs.values()) {
    if (j.state === "running" || j.state === "paused") return j;
  }
  return undefined;
}

export function pausedVideoJob(): VideoJob | undefined {
  for (const j of videoJobs.values()) {
    if (j.state === "paused") return j;
  }
  return undefined;
}

export function newVideoJob(): VideoJob {
  const job = new VideoJob(
    `vjob-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
  );
  videoJobs.set(job.id, job);
  if (videoJobs.size > 40) {
    const oldest = [...videoJobs.values()].find((j) => j.state !== "running");
    if (oldest) videoJobs.delete(oldest.id);
  }
  return job;
}
