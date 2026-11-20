/**
 * Dynamic CPU detection, affinity masking, and process throttling.
 *
 * Allows bounding ImageMagick's processor utilization to a user-selected
 * percentage (default 70%, adjustable 10% - 100%) mid-run.
 */
import os from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { dlopen, FFIType } from "bun:ffi";

export function getTotalCpus(): number {
  return os.availableParallelism?.() ?? os.cpus().length ?? 1;
}

/**
 * Calculates a CPU affinity bitmask corresponding to the requested CPU percentage.
 *
 * For example, on an 8-thread system:
 *   70% -> 5 cores -> mask 0x1Fn (0b00011111)
 *   50% -> 4 cores -> mask 0x0Fn (0b00001111)
 *  100% -> 8 cores -> mask 0xFFn (0b11111111)
 *
 * The percentage always applies to the REAL thread count, not to a clamped
 * figure (128 threads at 50% = 64 threads, not 32). A group-affinity mask is
 * 64-bit wide, so >64-thread boxes consciously get the full first group.
 */
export function calculateAffinityMask(percent: number, rawTotalCpus = getTotalCpus()): bigint {
  const safeCpus = Number.isFinite(rawTotalCpus) ? rawTotalCpus : 1;
  const totalCpus = Math.max(1, Math.floor(safeCpus));
  const safePct = Number.isFinite(percent) ? percent : 70;
  const pct = Math.max(10, Math.min(100, Math.round(safePct) || 70));
  if (pct >= 100) {
    const width = Math.min(totalCpus, 64);
    return (1n << BigInt(width)) - 1n;
  }
  const allowed = Math.max(
    1,
    Math.min(totalCpus, 64, Math.floor(totalCpus * (pct / 100))),
  );
  return (1n << BigInt(allowed)) - 1n;
}

// Windows kernel32 dynamic bindings for process affinity and sleep inhibition
type Kernel32 = {
  symbols: {
    OpenProcess: (dwDesiredAccess: number, bInheritHandle: boolean, dwProcessId: number) => number | bigint | null;
    SetProcessAffinityMask: (hProcess: any, dwProcessAffinityMask: bigint) => boolean;
    CloseHandle: (hObject: any) => boolean;
    SetThreadExecutionState?: (esFlags: number) => number;
  };
};

type Ntdll = {
  symbols: {
    NtSuspendProcess: (hProcess: any) => number;
    NtResumeProcess: (hProcess: any) => number;
  };
};

let k32: Kernel32 | null = null;
let ntdll: Ntdll | null = null;

if (process.platform === "win32") {
  try {
    k32 = dlopen("kernel32.dll", {
      OpenProcess: {
        args: [FFIType.u32, FFIType.bool, FFIType.u32],
        returns: FFIType.ptr,
      },
      SetProcessAffinityMask: {
        args: [FFIType.ptr, FFIType.u64],
        returns: FFIType.bool,
      },
      CloseHandle: {
        args: [FFIType.ptr],
        returns: FFIType.bool,
      },
      SetThreadExecutionState: {
        args: [FFIType.u32],
        returns: FFIType.u32,
      },
    }) as unknown as Kernel32;

    ntdll = dlopen("ntdll.dll", {
      NtSuspendProcess: {
        args: [FFIType.ptr],
        returns: FFIType.i32,
      },
      NtResumeProcess: {
        args: [FFIType.ptr],
        returns: FFIType.i32,
      },
    }) as unknown as Ntdll;
  } catch {
    k32 = null;
    ntdll = null;
  }
}

// Minimal rights required for SetProcessAffinityMask (avoids UAC/AV heuristics)
const PROCESS_AFFINITY_ACCESS = 0x0200 | 0x1000;
// PROCESS_SUSPEND_RESUME = 0x0800
const PROCESS_SUSPEND_RESUME = 0x0800;

/**
 * Signals a Linux process group, falling back to the single PID.
 *
 * AppImage builds run through a wrapper that forks the real `magick`; only
 * signalling `-pid` reaches both. Children we did not spawn detached are not
 * group leaders, so the single-PID fallback keeps them working.
 */
function signalLinux(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    /* not a process-group leader */
  }
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * Freezes a running process in memory in <1ms without killing it.
 * Uses NtSuspendProcess on Windows and SIGSTOP on Linux.
 */
export function suspendProcess(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  if (process.platform === "linux") {
    return signalLinux(pid, "SIGSTOP");
  }
  if (k32 && ntdll) {
    try {
      const handle = k32.symbols.OpenProcess(PROCESS_SUSPEND_RESUME, false, pid);
      if (handle) {
        const status = ntdll.symbols.NtSuspendProcess(handle);
        k32.symbols.CloseHandle(handle);
        return status === 0;
      }
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Resumes a suspended process from the exact frame/state it was frozen.
 * Uses NtResumeProcess on Windows and SIGCONT on Linux.
 */
export function resumeProcess(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  if (process.platform === "linux") {
    return signalLinux(pid, "SIGCONT");
  }
  if (k32 && ntdll) {
    try {
      const handle = k32.symbols.OpenProcess(PROCESS_SUSPEND_RESUME, false, pid);
      if (handle) {
        const status = ntdll.symbols.NtResumeProcess(handle);
        k32.symbols.CloseHandle(handle);
        return status === 0;
      }
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Bounded wait for the Linux `taskset` helper. A missing or hung binary must
 * never stall the event loop (and therefore SSE / UI) for the old
 * 10 s × active-PID worst case of the removed spawnSync() call.
 */
const TASKSET_TIMEOUT_MS = 2_000;

/** Windows affinity via kernel32; returns false on non-Windows platforms. */
function setWindowsAffinity(pid: number, percent: number): boolean {
  if (!k32) return false;
  try {
    const mask = calculateAffinityMask(percent);
    const handle = k32.symbols.OpenProcess(PROCESS_AFFINITY_ACCESS, false, pid);
    if (handle) {
      const ok = Boolean(k32.symbols.SetProcessAffinityMask(handle, mask));
      k32.symbols.CloseHandle(handle);
      return ok;
    }
  } catch {
    // Fallback silently if OS denies affinity change
  }
  return false;
}

/** BELOW_NORMAL priority is best-effort on every platform. */
function setBackgroundPriority(pid: number): void {
  try {
    os.setPriority(pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    // Ignore priority errors
  }
}

/**
 * CPU-B fix: non-blocking `taskset -pc` with the original affinity semantics.
 * Resolves `true` only when taskset actually applied the affinity (exit 0);
 * `false` on ENOENT, timeout, or non-zero exit. A bounded timer kills a hung
 * helper, and every failure is logged so a silently missing taskset is
 * observable instead of making the UI claim success.
 */
function tasksetAffinityAsync(pid: number, percent: number): Promise<boolean> {
  const total = getTotalCpus();
  const allowed = Math.max(1, Math.min(total, Math.floor(total * (percent / 100))));
  return new Promise<boolean>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn("taskset", ["-pc", `0-${allowed - 1}`, String(pid)], { stdio: "ignore" });
    } catch (err) {
      console.warn(`[cpu] taskset spawn failed for pid ${pid}:`, err);
      resolve(false);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (ok: boolean, why?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (why) console.warn(`[cpu] taskset ${why} for pid ${pid}`);
      resolve(ok);
    };
    timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish(false, "timed out");
    }, TASKSET_TIMEOUT_MS);
    child.once("error", (err) => {
      console.warn(`[cpu] taskset unavailable for pid ${pid}:`, err);
      finish(false);
    });
    child.once("close", (code) => finish(code === 0, code === 0 ? undefined : `exited ${code}`));
  });
}

/**
 * Applies CPU affinity and background process priority to a running process.
 * Can be called repeatedly on active processes to adjust CPU limits mid-run.
 *
 * Kept synchronous for spawn-side callers that cannot await (convert.ts,
 * estimate.ts, video/*, and the platform check). On Linux the taskset work is
 * now fire-and-forget with a bounded timer + error logging, so a missing or
 * hung taskset can never block the event loop. Callers that need the real
 * result use applyProcessCpuLimitAsync() instead.
 */
export function applyProcessCpuLimit(pid: number | undefined, percent: number): boolean {
  if (!pid || pid <= 0) return false;
  const clampedPct = Number.isFinite(percent) ? Math.max(10, Math.min(100, Math.round(percent))) : 70;
  const success = setWindowsAffinity(pid, clampedPct);
  if (process.platform === "linux") {
    // Non-blocking: result checking + warning happen inside the helper. The
    // boolean return stays synchronous (false here = "not reported applied").
    void tasksetAffinityAsync(pid, clampedPct);
  }
  setBackgroundPriority(pid);
  return success;
}

/**
 * Async counterpart of applyProcessCpuLimit(): resolves only after the Linux
 * taskset helper settles (or its bounded timer fires), so callers can coalesce
 * per-PID updates with Promise.all() without serializing the waits.
 */
export async function applyProcessCpuLimitAsync(pid: number | undefined, percent: number): Promise<boolean> {
  if (!pid || pid <= 0) return false;
  const clampedPct = Number.isFinite(percent) ? Math.max(10, Math.min(100, Math.round(percent))) : 70;
  let success = setWindowsAffinity(pid, clampedPct);
  if (process.platform === "linux") {
    success = await tasksetAffinityAsync(pid, clampedPct);
  }
  setBackgroundPriority(pid);
  return success;
}

// ---------------------------------------------------------------------------
// Sleep inhibition during active batch runs
// ---------------------------------------------------------------------------

const ES_CONTINUOUS = 0x80000000;
const ES_SYSTEM_REQUIRED = 0x00000001;
const ES_AWAYMODE_REQUIRED = 0x00000040;

let sleepInhibitRefCount = 0;
let linuxInhibitChild: ChildProcess | null = null;

/**
 * Prevents OS idle sleep while media conversions are actively running.
 * Reference-counted so overlapping photo/video runs do not prematurely drop the lock.
 */
export function acquireSleepInhibit(): void {
  sleepInhibitRefCount++;
  if (sleepInhibitRefCount > 1) return;

  if (process.platform === "win32" && k32?.symbols.SetThreadExecutionState) {
    try {
      k32.symbols.SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_AWAYMODE_REQUIRED);
    } catch {
      // ignore
    }
  } else if (process.platform === "linux") {
    try {
      const child = spawn(
        "systemd-inhibit",
        [
          "--what=idle:sleep",
          "--who=picmagik",
          "--why=Batch media processing active",
          "--mode=block",
          "sleep",
          "infinity",
        ],
        { stdio: "ignore" },
      );
      child.on("error", () => {
        if (linuxInhibitChild === child) linuxInhibitChild = null;
      });
      child.on("exit", () => {
        if (linuxInhibitChild === child) linuxInhibitChild = null;
      });
      child.unref();
      linuxInhibitChild = child;
    } catch {
      // systemd-inhibit not available
    }
  }
}

/**
 * Releases sleep inhibition lock. Re-enables system idle sleep once refcount reaches 0.
 */
export function releaseSleepInhibit(): void {
  if (sleepInhibitRefCount <= 0) return;
  sleepInhibitRefCount--;
  if (sleepInhibitRefCount > 0) return;

  if (process.platform === "win32" && k32?.symbols.SetThreadExecutionState) {
    try {
      k32.symbols.SetThreadExecutionState(ES_CONTINUOUS);
    } catch {
      // ignore
    }
  } else if (process.platform === "linux") {
    if (linuxInhibitChild) {
      try {
        linuxInhibitChild.kill();
      } catch {
        // ignore
      }
      linuxInhibitChild = null;
    }
  }
}

process.on("exit", () => {
  if (linuxInhibitChild) {
    try {
      linuxInhibitChild.kill();
    } catch {
      // ignore
    }
    linuxInhibitChild = null;
  }
  if (process.platform === "win32" && k32?.symbols.SetThreadExecutionState && sleepInhibitRefCount > 0) {
    try {
      k32.symbols.SetThreadExecutionState(ES_CONTINUOUS);
    } catch {
      // ignore
    }
  }
});
