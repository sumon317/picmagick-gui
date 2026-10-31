/**
 * Dynamic CPU detection, affinity masking, and process throttling.
 *
 * Allows bounding ImageMagick's processor utilization to a user-selected
 * percentage (default 70%, adjustable 10% - 100%) mid-run.
 */
import os from "node:os";
import { spawn } from "node:child_process";
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
 */
export function calculateAffinityMask(percent: number, rawTotalCpus = getTotalCpus()): bigint {
  const totalCpus = Math.max(1, Math.min(64, rawTotalCpus));
  const pct = Math.max(10, Math.min(100, Math.round(percent) || 70));
  if (pct >= 100) {
    return (1n << BigInt(totalCpus)) - 1n;
  }
  const allowed = Math.max(1, Math.min(totalCpus, Math.floor(totalCpus * (pct / 100))));
  return (1n << BigInt(allowed)) - 1n;
}

// Windows kernel32 dynamic bindings for process affinity
type Kernel32 = {
  symbols: {
    OpenProcess: (dwDesiredAccess: number, bInheritHandle: boolean, dwProcessId: number) => number | bigint | null;
    SetProcessAffinityMask: (hProcess: any, dwProcessAffinityMask: bigint) => boolean;
    CloseHandle: (hObject: any) => boolean;
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

// PROCESS_ALL_ACCESS = 0x1F0FFF (or PROCESS_SET_INFORMATION | PROCESS_QUERY_INFORMATION)
const PROCESS_AFFINITY_ACCESS = 0x1F0FFF;
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
 * Applies CPU affinity and background process priority to a running process.
 * Can be called repeatedly on active processes to adjust CPU limits mid-run.
 */
export function applyProcessCpuLimit(pid: number | undefined, percent: number): boolean {
  if (!pid || pid <= 0) return false;
  let success = false;

  if (k32) {
    try {
      const mask = calculateAffinityMask(percent);
      const handle = k32.symbols.OpenProcess(PROCESS_AFFINITY_ACCESS, false, pid);
      if (handle) {
        success = Boolean(k32.symbols.SetProcessAffinityMask(handle, mask));
        k32.symbols.CloseHandle(handle);
      }
    } catch {
      // Fallback silently if OS denies affinity change
    }
  }

  if (process.platform === "linux") {
    try {
      const total = getTotalCpus();
      const allowed = Math.max(1, Math.min(total, Math.floor(total * (percent / 100))));
      spawn("taskset", ["-pc", `0-${allowed - 1}`, String(pid)], { stdio: "ignore" }).unref();
      success = true;
    } catch {
      // Fallback silently if taskset is not installed
    }
  }

  try {
    // Set priority class to BELOW_NORMAL so the system stays responsive
    os.setPriority(pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    // Ignore priority errors
  }

  return success;
}
