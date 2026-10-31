/**
 * Run lifecycle: start, reattach, stream, pause, resume, cancel, and job tuning.
 *
 * The server is the only owner of run progress. The SSE stream is a view of the
 * job; on a dropped connection we re-read /api/job/state instead of inventing a
 * completion state.
 */
import { api, resolveApiRoute } from "./api";
import { fmt } from "./dom";
import { resetRun, state } from "./state";
import type {
  JobSnapshot,
  JobState,
  Policy,
  ProgressEvent,
  RunResponse,
  FileResult,
  VideoPolicy,
} from "./types";

export type RunLifecycleOptions = {
  policy: () => Policy | VideoPolicy;
  save: () => Promise<void>;
  render: () => void;
  openRunView: () => void;
  onFinished: () => Promise<void>;
  onError: (message: string) => void;
  onInfo: (message: string) => void;
  lockFormat: (locked: boolean) => void;
};

export type RunLifecycle = {
  start: (opts?: { onlyNew?: boolean }) => Promise<void>;
  attach: (jobId: string, replay: boolean) => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  cancel: () => Promise<void>;
  setJobs: (jobs: number) => void;
  setCpuLimit: (cpuLimit: number) => void;
};

export function createRunLifecycle(options: RunLifecycleOptions): RunLifecycle {
  let jobsTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnecting = false;

  const isActive = (): boolean => state.running || state.starting;

  const render = (): void => {
    options.render();
  };

  const setActivity = (file: FileResult | undefined): void => {
    if (!file) return;
    state.activity.push(file);
    if (state.activity.length > 500) state.activity.splice(0, state.activity.length - 500);
    state.run.lastRel = file.rel;
    state.run.lastStatus = file.status;
  };

  const finish = (p: ProgressEvent): void => {
    state.es?.close();
    state.es = null;
    state.currentJob = null;
    state.running = false;
    state.starting = false;
    state.lastJobId = p.jobId ?? state.run.id;
    state.lastSummary = p.summary ?? null;
    state.lastManifestId = p.manifestId ?? null;

    const summary = p.summary;
    if (summary) {
      state.run.total = summary.total;
      state.run.done = summary.done;
      state.run.converted = summary.converted;
      state.run.copied = summary.copied;
      state.run.skipped = summary.skipped;
      state.run.failed = summary.failed;
      state.run.bytes = summary.bytes;
      state.run.elapsedSeconds = summary.elapsedSeconds;
      state.run.etaSeconds = null;
    }
    state.run.state = summary?.note === "cancelled"
      ? "cancelled"
      : p.state === "failed" || (summary?.failed ?? 0) > 0 && summary?.converted === 0 && summary?.copied === 0
        ? "failed"
        : "done";
    state.run.note = null;
    state.run.startingRel = null;
    state.run.startingBytes = null;
    state.run.inFlight = 0;

    options.lockFormat(false);
    render();

    if (summary?.note === "cancelled") {
      options.onInfo(`Cancelled. ${(summary?.done ?? 0).toLocaleString()} of ${(summary?.total ?? 0).toLocaleString()} done; those files stay on disk and will be skipped next time.`);
    } else if (summary) {
      const failed = summary.failed ? `, ${summary.failed.toLocaleString()} failed` : "";
      options.onInfo(`Done. ${summary.converted.toLocaleString()} converted, ${summary.copied.toLocaleString()} copied${failed} → ${fmt(summary.bytes)}.`);
    }
    void options.onFinished();
  };

  const handleEvent = (event: ProgressEvent): void => {
    if (event.type === "hello") {
      if (event.jobId) state.run.id = event.jobId;
      if (event.state) {
        state.run.state = event.state;
        if (event.state === "paused") state.run.note = "Paused";
      }
    } else if (event.type === "start" || event.type === "resumed") {
      state.run.state = "running";
      state.running = true;
      state.starting = false;
      if (event.total != null) state.run.total = event.total;
      state.run.note = event.message ?? null;
    } else if (event.type === "progress") {
      state.run.state = "running";
      state.running = true;
      state.starting = false;
      state.run.total = event.total ?? state.run.total;
      state.run.done = event.done ?? state.run.done;
      state.run.converted = event.converted ?? state.run.converted;
      state.run.copied = event.copied ?? state.run.copied;
      state.run.skipped = event.skipped ?? state.run.skipped;
      state.run.failed = event.failed ?? state.run.failed;
      state.run.bytes = event.bytes ?? state.run.bytes;
      state.run.etaSeconds = event.etaSeconds ?? null;
      state.run.elapsedSeconds = event.elapsedSeconds ?? state.run.elapsedSeconds;
      state.run.inFlight = event.inFlight ?? state.run.inFlight;
      if (event.starting) {
        state.run.startingRel = event.starting.rel;
        state.run.startingBytes = event.starting.bytes;
      }
      setActivity(event.file);
      if (event.file) {
        state.run.startingRel = null;
        state.run.startingBytes = null;
      }
      state.run.note = event.inFlight
        ? `Converting · ${event.inFlight} in flight`
        : null;
    } else if (event.type === "paused") {
      state.run.state = "paused";
      state.running = true;
      state.starting = false;
      state.run.note = event.message ?? "Paused";
      state.run.inFlight = 0;
      state.run.startingRel = null;
      state.run.startingBytes = null;
      options.onInfo(event.message ?? "Paused after the current files finished.");
    } else if (event.type === "finish") {
      finish(event);
      return;
    } else if (event.type === "error") {
      state.es?.close();
      state.es = null;
      state.currentJob = null;
      state.running = false;
      state.starting = false;
      state.run.state = "failed";
      state.run.note = event.message ?? "The run failed.";
      state.lastJobError = event.message ?? "The run failed.";
      state.run.inFlight = 0;
      state.run.startingRel = null;
      state.run.startingBytes = null;
      options.lockFormat(false);
      options.onError(event.message ?? "The run failed.");
      void options.onFinished();
    }
    render();
  };

  const stream = (jobId: string): void => {
    state.es?.close();
    const source = new EventSource(`/api/${resolveApiRoute(`stream/${encodeURIComponent(jobId)}`)}`);
    state.es = source;

    source.onmessage = (message) => {
      try {
        handleEvent(JSON.parse(message.data) as ProgressEvent);
      } catch {
        /* A malformed frame is ignored; the next progress event is authoritative. */
      }
    };

    source.onerror = () => {
      if (!state.running || state.es !== source) {
        source.close();
        return;
      }
      source.close();
      state.es = null;
      if (reconnecting) return;
      reconnecting = true;
      state.run.note = "Connection lost — reconnecting…";
      render();
      window.setTimeout(() => {
        void (async () => {
          try {
            await api<JobSnapshot>(`job/state?id=${encodeURIComponent(jobId)}`);
            await attach(jobId, true);
          } catch {
            state.running = false;
            state.currentJob = null;
            state.run.state = "failed";
            state.run.note = "Lost contact with the server. The files already written stay on disk.";
            options.lockFormat(false);
            options.onError(state.run.note);
            render();
          } finally {
            reconnecting = false;
          }
        })();
      }, 1200);
    };
  };

  const hydrate = (snapshot: JobSnapshot): void => {
    state.run.id = snapshot.id;
    state.run.state = snapshot.state === "idle" ? "running" : snapshot.state;
    state.run.total = snapshot.total;
    state.run.done = snapshot.done;
    state.run.converted = snapshot.converted;
    state.run.copied = snapshot.copied;
    state.run.skipped = snapshot.skipped;
    state.run.failed = snapshot.failed;
    state.run.bytes = snapshot.bytes;
    state.run.inFlight = snapshot.inFlight;
    state.run.note = snapshot.state === "paused"
      ? "Paused after the current files finished."
      : snapshot.state === "running"
        ? null
        : state.run.note;
    state.running = snapshot.state === "running" || snapshot.state === "paused";
    state.starting = false;
    state.currentJob = snapshot.id;
    state.lastJobId = snapshot.id;
    options.lockFormat(true);
    const jobs = document.getElementById("jobs") as HTMLInputElement | null;
    if (jobs && snapshot.jobs) {
      jobs.value = String(snapshot.jobs);
      const out = document.getElementById("jobsOut");
      if (out) out.textContent = String(snapshot.jobs);
    }
    const cpuLimit = document.getElementById("cpuLimit") as HTMLInputElement | null;
    if (cpuLimit && snapshot.cpuLimit) {
      cpuLimit.value = String(snapshot.cpuLimit);
      const out = document.getElementById("cpuLimitOut");
      if (out) out.textContent = `${snapshot.cpuLimit}%`;
    }
    render();
  };

  const attach = async (jobId: string, replay: boolean): Promise<void> => {
    state.currentJob = jobId;
    state.running = true;
    state.starting = true;
    state.run.id = jobId;
    state.run.state = "running";
    options.lockFormat(true);
    render();
    if (replay) {
      try {
        const snapshot = await api<JobSnapshot>(`job/state?id=${encodeURIComponent(jobId)}`);
        hydrate(snapshot);
      } catch {
        state.running = false;
        state.starting = false;
        state.currentJob = null;
        options.lockFormat(false);
        render();
        throw new Error("That run is no longer available.");
      }
    }
    state.starting = false;
    state.running = true;
    stream(jobId);
    render();
  };

  const start = async (runOptions: { onlyNew?: boolean } = {}): Promise<void> => {
    if (isActive()) return;
    state.starting = true;
    render();
    try {
      await options.save();
      const jobsInput = document.getElementById("jobs") as HTMLInputElement | null;
      const cpuLimitInput = document.getElementById("cpuLimit") as HTMLInputElement | null;
      const overwrite = document.getElementById("overwrite") as HTMLInputElement | null;
      const onlyNew = document.getElementById("onlyNew") as HTMLInputElement | null;
      const isCustomVideo = state.mediaMode === "video" && state.videoDestMode === "custom";
      const customDest = isCustomVideo
        ? ((document.getElementById("destination") as HTMLInputElement | null)?.value.trim() || state.videoCustomDestination)
        : undefined;
      const response = await api<RunResponse>("run", {
        method: "POST",
        body: {
          jobs: jobsInput?.valueAsNumber ?? 2,
          cpuLimit: cpuLimitInput?.valueAsNumber ?? 70,
          overwrite: Boolean(overwrite?.checked),
          onlyNew: Boolean(runOptions.onlyNew ?? onlyNew?.checked),
          policy: options.policy(),
          customDestination: customDest,
          destination: customDest,
        },
      });
      resetRun(response.total);
      state.run.id = response.jobId;
      state.run.state = "running";
      state.starting = false;
      state.running = true;
      state.currentJob = response.jobId;
      state.lastJobId = response.jobId;
      state.lastManifestId = null;
      state.lastJobError = null;
      options.lockFormat(true);
      options.openRunView();
      render();
      stream(response.jobId);
    } catch (error) {
      state.starting = false;
      state.running = false;
      state.currentJob = null;
      options.lockFormat(false);
      render();
      options.onError((error as Error).message);
    }
  };

  const post = async (path: string, success?: string): Promise<boolean> => {
    if (!state.currentJob) return false;
    try {
      await api(path, { method: "POST" });
      if (success) {
        state.run.note = success;
        render();
      }
      return true;
    } catch (error) {
      options.onError((error as Error).message);
      return false;
    }
  };

  const pause = async (): Promise<void> => {
    await post(`pause/${encodeURIComponent(state.currentJob ?? "")}`, "Pausing after the current files finish…");
  };

  const resume = async (): Promise<void> => {
    if (!state.currentJob) return;
    const ok = await post(`resume/${encodeURIComponent(state.currentJob)}`);
    if (!ok) return;
    state.run.state = "running";
    state.run.note = "Resuming…";
    state.running = true;
    render();
  };

  const cancel = async (): Promise<void> => {
    await post(`cancel/${encodeURIComponent(state.currentJob ?? "")}`, "Cancelling…");
  };

  const setJobs = (jobs: number): void => {
    if (!state.currentJob) return;
    if (jobsTimer) clearTimeout(jobsTimer);
    jobsTimer = setTimeout(() => {
      void api(`jobs/${encodeURIComponent(state.currentJob ?? "")}`, {
        method: "POST",
        body: { jobs },
      }).catch((error: unknown) => options.onError((error as Error).message));
    }, 200);
  };

  let cpuLimitTimer: ReturnType<typeof setTimeout> | null = null;
  const setCpuLimit = (cpuLimit: number): void => {
    if (!state.currentJob) return;
    if (cpuLimitTimer) clearTimeout(cpuLimitTimer);
    cpuLimitTimer = setTimeout(() => {
      void api(`jobs/${encodeURIComponent(state.currentJob ?? "")}`, {
        method: "POST",
        body: { cpuLimit },
      }).catch((error: unknown) => options.onError((error as Error).message));
    }, 200);
  };

  return { start, attach, pause, resume, cancel, setJobs, setCpuLimit };
}
