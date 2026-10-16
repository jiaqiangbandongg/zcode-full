import type * as Koffi from "koffi";

const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x0000_2000;
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_TERMINATE = 0x0001;

type WindowsJobHandle = object;

export interface WindowsJobObjectController {
  terminate(): void;
  close(): void;
}

export interface WindowsJobObjectApi {
  create(): WindowsJobHandle | undefined;
  assign(job: WindowsJobHandle, pid: number): boolean;
  terminate(job: WindowsJobHandle): void;
  close(job: WindowsJobHandle): void;
}

interface AttachOptions {
  api?: WindowsJobObjectApi;
  platform?: NodeJS.Platform;
}

export async function attachProcessToWindowsJobObject(
  pid: number,
  options: AttachOptions = {},
): Promise<WindowsJobObjectController | undefined> {
  if ((options.platform ?? process.platform) !== "win32") return undefined;
  if (!Number.isInteger(pid) || pid <= 0) return undefined;

  const api = options.api ?? (await loadWindowsJobObjectApi());
  if (!api) return undefined;

  let job: WindowsJobHandle | undefined;
  try {
    job = api.create();
    if (!job || !api.assign(job, pid)) {
      if (job) api.close(job);
      return undefined;
    }
  } catch {
    if (job) {
      try {
        api.close(job);
      } catch {
        // 原生句柄关闭失败也不能阻断既有 taskkill 回退。
      }
    }
    return undefined;
  }

  let closed = false;
  return {
    terminate() {
      if (!closed) api.terminate(job);
    },
    close() {
      if (closed) return;
      closed = true;
      api.close(job);
    },
  };
}

let nativeApiPromise: Promise<WindowsJobObjectApi | undefined> | undefined;

async function loadWindowsJobObjectApi(): Promise<WindowsJobObjectApi | undefined> {
  nativeApiPromise ??= createWindowsJobObjectApi();
  return nativeApiPromise;
}

async function createWindowsJobObjectApi(): Promise<WindowsJobObjectApi | undefined> {
  try {
    const koffiModule = await import("koffi");
    const koffi = ("default" in koffiModule ? koffiModule.default : koffiModule) as typeof Koffi;
    const kernel32 = koffi.load("kernel32.dll");
    const handleType = koffi.pointer("HANDLE", koffi.opaque());
    const basicLimitInformation = koffi.struct("JOBOBJECT_BASIC_LIMIT_INFORMATION", {
      PerProcessUserTimeLimit: "int64",
      PerJobUserTimeLimit: "int64",
      LimitFlags: "uint32",
      MinimumWorkingSetSize: "size_t",
      MaximumWorkingSetSize: "size_t",
      ActiveProcessLimit: "uint32",
      Affinity: "uintptr_t",
      PriorityClass: "uint32",
      SchedulingClass: "uint32",
    });
    const ioCounters = koffi.struct("IO_COUNTERS", {
      ReadOperationCount: "uint64",
      WriteOperationCount: "uint64",
      OtherOperationCount: "uint64",
      ReadTransferCount: "uint64",
      WriteTransferCount: "uint64",
      OtherTransferCount: "uint64",
    });
    const extendedLimitInformation = koffi.struct("JOBOBJECT_EXTENDED_LIMIT_INFORMATION", {
      BasicLimitInformation: basicLimitInformation,
      IoInfo: ioCounters,
      ProcessMemoryLimit: "size_t",
      JobMemoryLimit: "size_t",
      PeakProcessMemoryUsed: "size_t",
      PeakJobMemoryUsed: "size_t",
    });

    const createJobObject = kernel32.func("__stdcall", "CreateJobObjectW", handleType, [
      "void *",
      "str16",
    ]);
    const setInformationJobObject = kernel32.func(
      "__stdcall",
      "SetInformationJobObject",
      "bool",
      [handleType, "uint32", koffi.pointer(extendedLimitInformation), "uint32"],
    );
    const openProcess = kernel32.func("__stdcall", "OpenProcess", handleType, [
      "uint32",
      "bool",
      "uint32",
    ]);
    const assignProcessToJobObject = kernel32.func(
      "__stdcall",
      "AssignProcessToJobObject",
      "bool",
      [handleType, handleType],
    );
    const terminateJobObject = kernel32.func("__stdcall", "TerminateJobObject", "bool", [
      handleType,
      "uint32",
    ]);
    const closeHandle = kernel32.func("__stdcall", "CloseHandle", "bool", [handleType]);

    return {
      create() {
        const job = createJobObject(null, null) as WindowsJobHandle | null;
        if (!job) return undefined;
        const limits = {
          BasicLimitInformation: {
            PerProcessUserTimeLimit: 0,
            PerJobUserTimeLimit: 0,
            LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            MinimumWorkingSetSize: 0,
            MaximumWorkingSetSize: 0,
            ActiveProcessLimit: 0,
            Affinity: 0,
            PriorityClass: 0,
            SchedulingClass: 0,
          },
          IoInfo: {
            ReadOperationCount: 0,
            WriteOperationCount: 0,
            OtherOperationCount: 0,
            ReadTransferCount: 0,
            WriteTransferCount: 0,
            OtherTransferCount: 0,
          },
          ProcessMemoryLimit: 0,
          JobMemoryLimit: 0,
          PeakProcessMemoryUsed: 0,
          PeakJobMemoryUsed: 0,
        };
        if (
          !setInformationJobObject(
            job,
            JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
            limits,
            koffi.sizeof(extendedLimitInformation),
          )
        ) {
          closeHandle(job);
          return undefined;
        }
        return job;
      },
      assign(job, pid) {
        const processHandle = openProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid) as
          | WindowsJobHandle
          | null;
        if (!processHandle) return false;
        try {
          return Boolean(assignProcessToJobObject(job, processHandle));
        } finally {
          closeHandle(processHandle);
        }
      },
      terminate(job) {
        terminateJobObject(job, 1);
      },
      close(job) {
        closeHandle(job);
      },
    } satisfies WindowsJobObjectApi;
  } catch {
    // 原生模块或 Windows API 不可用时保持既有 taskkill 回退，不影响其他平台。
    return undefined;
  }
}
