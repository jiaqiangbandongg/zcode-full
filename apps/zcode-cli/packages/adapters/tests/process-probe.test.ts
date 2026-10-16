import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProcessProbe,
  PROCESS_PROBE_MAX_CONSECUTIVE_FAILURES,
  PROCESS_PROBE_SAMPLE_TIMEOUT_MS,
} from "../src/device/process-probe.js";

/** macOS `ps -eo pid=,ppid=,rss=,cputime=` 的典型输出：100 → 101 → 102 一棵树，200、300 各自独立。 */
const DARWIN_PROCESS_TABLE = [
  "  100     1     50   0:01.00",
  "  101   100     25   0:00.50",
  "  102   101     10   1:02.25",
  "  200     1     30   0:00.00",
  "  300     1     15  10:00.00",
].join("\n");

/** `/proc/<pid>/stat` 前 15 个字段：comm 允许含空格与括号，解析必须以最后一个 `)` 为界。 */
function linuxStatLine(input: {
  pid: number;
  parentPid: number;
  processGroupId: number;
  utimeTicks: number;
  stimeTicks: number;
}): string {
  return [
    String(input.pid),
    "(node (worker))",
    "S",
    String(input.parentPid),
    String(input.processGroupId),
    "0",
    "-1",
    "-1",
    "4194304",
    "1234",
    "0",
    "0",
    "0",
    String(input.utimeTicks),
    String(input.stimeTicks),
    "0",
    "0",
  ].join(" ");
}

function linuxStatusText(rssKb: number): string {
  return ["Name:\tnode", "State:\tS (sleeping)", `VmRSS:\t   ${rssKb} kB`, ""].join("\n");
}

function commandResult(stdout: string) {
  return { status: 0, stderr: "", stdout };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("通用进程探针 - macOS", () => {
  it("按 pid 列表一次 ps 采整棵进程树，输出每进程 RSS 与累计 CPU 时间", async () => {
    const execFile = vi.fn(async () => commandResult(DARWIN_PROCESS_TABLE));

    const probe = createProcessProbe({ execFile, platform: "darwin" });
    const trees = await probe.sampleProcessTrees([100, 200, 999]);

    expect(execFile).toHaveBeenCalledOnce();
    expect(execFile).toHaveBeenCalledWith(
      "ps",
      ["-eo", "pid=,ppid=,rss=,cputime="],
      expect.objectContaining({ encoding: "utf8", timeout: PROCESS_PROBE_SAMPLE_TIMEOUT_MS }),
    );
    expect(trees).toEqual(
      new Map([
        [
          100,
          [
            { pid: 100, rssKb: 50, cpuTimeMs: 1_000 },
            { pid: 101, rssKb: 25, cpuTimeMs: 500 },
            { pid: 102, rssKb: 10, cpuTimeMs: 62_250 },
          ],
        ],
        [200, [{ pid: 200, rssKb: 30, cpuTimeMs: 0 }]],
      ]),
    );
  });

  it("按进程组一次 ps 采样且参数带 -g", async () => {
    const execFile = vi.fn(async () =>
      commandResult(["  400     20   0:02.00", "  401     30   1-00:00:00"].join("\n")),
    );

    const probe = createProcessProbe({ execFile, platform: "darwin" });
    const samples = await probe.sampleProcessGroup(4_242);

    expect(execFile).toHaveBeenCalledOnce();
    expect(execFile).toHaveBeenCalledWith(
      "ps",
      ["-o", "pid=,rss=,cputime=", "-g", "4242"],
      expect.objectContaining({ encoding: "utf8", timeout: PROCESS_PROBE_SAMPLE_TIMEOUT_MS }),
    );
    expect(samples).toEqual([
      { pid: 400, rssKb: 20, cpuTimeMs: 2_000 },
      { pid: 401, rssKb: 30, cpuTimeMs: 86_400_000 },
    ]);
  });

  it("pid 列表为空时不启动任何外部进程", async () => {
    const execFile = vi.fn(async () => commandResult(""));

    const probe = createProcessProbe({ execFile, platform: "darwin" });

    expect(await probe.sampleProcessTrees([])).toEqual(new Map());
    expect(await probe.sampleProcessTrees([0, -1, 1.5])).toEqual(new Map());
    expect(execFile).not.toHaveBeenCalled();
  });
});

describe("通用进程探针 - Linux", () => {
  function createProcFileSystem(rssByPid: ReadonlyMap<number, number | undefined>) {
    const statByPid = new Map<number, string>([
      [
        100,
        linuxStatLine({
          pid: 100,
          parentPid: 1,
          processGroupId: 100,
          utimeTicks: 130,
          stimeTicks: 20,
        }),
      ],
      [
        101,
        linuxStatLine({
          pid: 101,
          parentPid: 100,
          processGroupId: 100,
          utimeTicks: 5,
          stimeTicks: 5,
        }),
      ],
      [
        500,
        linuxStatLine({
          pid: 500,
          parentPid: 1,
          processGroupId: 500,
          utimeTicks: 0,
          stimeTicks: 0,
        }),
      ],
    ]);
    const listProcDirectory = vi.fn(async () => ["1", "100", "101", "500", "self", "cpuinfo"]);
    const readProcFile = vi.fn(async (path: string) => {
      const match = /^\/proc\/(\d+)\/(stat|status)$/u.exec(path);
      if (!match) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      const pid = Number(match[1]);
      if (match[2] === "stat") {
        const stat = statByPid.get(pid);
        if (!stat) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return stat;
      }
      const rssKb = rssByPid.get(pid);
      // 进程在两次读取之间退出：status 已消失，探针必须跳过该 pid 而不是抛错。
      if (rssKb === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return linuxStatusText(rssKb);
    });
    return { listProcDirectory, readProcFile };
  }

  it("读 /proc 的 stat 与 status，不调用任何 child_process API", async () => {
    const execFile = vi.fn(async () => commandResult(""));
    const { listProcDirectory, readProcFile } = createProcFileSystem(
      new Map([
        [100, 50],
        [101, 25],
        [500, 90],
      ]),
    );

    const probe = createProcessProbe({
      execFile,
      listProcDirectory,
      platform: "linux",
      readProcFile,
    });
    const trees = await probe.sampleProcessTrees([100]);

    expect(execFile).not.toHaveBeenCalled();
    expect(trees).toEqual(
      new Map([
        [
          100,
          [
            { pid: 100, rssKb: 50, cpuTimeMs: 1_500 },
            { pid: 101, rssKb: 25, cpuTimeMs: 100 },
          ],
        ],
      ]),
    );
    const readPaths = readProcFile.mock.calls.map(([path]) => path);
    expect(readPaths).toContain("/proc/100/stat");
    expect(readPaths).toContain("/proc/100/status");
    // 只有落在目标进程树里的 pid 才需要读 status。
    expect(readPaths).not.toContain("/proc/500/status");
  });

  it("进程在读取期间退出时跳过该 pid 且不抛错", async () => {
    const { listProcDirectory, readProcFile } = createProcFileSystem(
      new Map([
        [100, 50],
        [101, undefined],
      ]),
    );

    const probe = createProcessProbe({ listProcDirectory, platform: "linux", readProcFile });

    expect(await probe.sampleProcessTrees([100])).toEqual(
      new Map([[100, [{ pid: 100, rssKb: 50, cpuTimeMs: 1_500 }]]]),
    );
  });

  it("按 pgid 过滤 /proc，不启动进程", async () => {
    const execFile = vi.fn(async () => commandResult(""));
    const { listProcDirectory, readProcFile } = createProcFileSystem(
      new Map([
        [100, 50],
        [101, 25],
        [500, 90],
      ]),
    );

    const probe = createProcessProbe({
      execFile,
      listProcDirectory,
      platform: "linux",
      readProcFile,
    });

    expect(await probe.sampleProcessGroup(100)).toEqual([
      { pid: 100, rssKb: 50, cpuTimeMs: 1_500 },
      { pid: 101, rssKb: 25, cpuTimeMs: 100 },
    ]);
    expect(execFile).not.toHaveBeenCalled();
  });

  it("/proc 不可读时本次无样本", async () => {
    const listProcDirectory = vi.fn(async () => {
      throw new Error("EACCES");
    });

    const probe = createProcessProbe({
      listProcDirectory,
      platform: "linux",
      readProcFile: async () => "",
    });

    expect(await probe.sampleProcessTrees([100])).toBeUndefined();
  });
});

describe("通用进程探针 - Windows", () => {
  const TASKLIST_OUTPUT = [
    '"node.exe","100","Console","1","12,345 K"',
    '"node.exe","200","Console","1","8,192 K"',
  ].join("\r\n");

  it("一次 tasklist 调用，样本没有 CPU 时间字段", async () => {
    const execFile = vi.fn(async () => commandResult(TASKLIST_OUTPUT));

    const probe = createProcessProbe({ execFile, platform: "win32" });
    const trees = await probe.sampleProcessTrees([100, 200]);

    expect(execFile).toHaveBeenCalledOnce();
    expect(execFile).toHaveBeenCalledWith(
      "tasklist",
      ["/FO", "CSV", "/NH"],
      expect.objectContaining({ timeout: PROCESS_PROBE_SAMPLE_TIMEOUT_MS, windowsHide: true }),
    );
    // Windows 只有直连进程内存，没有累计 CPU 时间；字段必须缺席而不是填 0。
    expect(trees).toEqual(
      new Map([
        [100, [{ pid: 100, rssKb: 12_345 }]],
        [200, [{ pid: 200, rssKb: 8_192 }]],
      ]),
    );
    expect(execFile.mock.calls.every(([command]) => command === "tasklist")).toBe(true);
  });

  it("Windows 没有进程组语义，直接返回无样本且不启动进程", async () => {
    const execFile = vi.fn(async () => commandResult(TASKLIST_OUTPUT));

    const probe = createProcessProbe({ execFile, platform: "win32" });

    expect(await probe.sampleProcessGroup(4_242)).toBeUndefined();
    expect(execFile).not.toHaveBeenCalled();
  });
});

describe("通用进程探针 - 超时与失败停用", () => {
  it("超过 1 秒返回无样本", async () => {
    vi.useFakeTimers();
    const execFile = vi.fn(() => new Promise<never>(() => undefined));

    const probe = createProcessProbe({ execFile, platform: "darwin" });
    const pending = probe.sampleProcessTrees([100]);
    await vi.advanceTimersByTimeAsync(PROCESS_PROBE_SAMPLE_TIMEOUT_MS);

    expect(await pending).toBeUndefined();
  });

  it("连续 3 次失败后不再调用外部命令，reset 后恢复", async () => {
    const execFile = vi.fn(async () => ({ status: 1, stderr: "boom", stdout: "" }));

    const probe = createProcessProbe({ execFile, platform: "darwin" });
    for (let attempt = 0; attempt < PROCESS_PROBE_MAX_CONSECUTIVE_FAILURES; attempt += 1) {
      expect(await probe.sampleProcessTrees([100])).toBeUndefined();
    }
    expect(execFile).toHaveBeenCalledTimes(PROCESS_PROBE_MAX_CONSECUTIVE_FAILURES);

    expect(await probe.sampleProcessTrees([100])).toBeUndefined();
    expect(await probe.sampleProcessGroup(4_242)).toBeUndefined();
    expect(execFile).toHaveBeenCalledTimes(PROCESS_PROBE_MAX_CONSECUTIVE_FAILURES);

    probe.reset();
    expect(await probe.sampleProcessTrees([100])).toBeUndefined();
    expect(execFile).toHaveBeenCalledTimes(PROCESS_PROBE_MAX_CONSECUTIVE_FAILURES + 1);
  });

  it("一次成功会清零连续失败计数", async () => {
    const stdout = ["  100     1     50   0:01.00"].join("\n");
    let shouldFail = true;
    const execFile = vi.fn(async () =>
      shouldFail ? { status: 1, stderr: "boom", stdout: "" } : commandResult(stdout),
    );

    const probe = createProcessProbe({ execFile, platform: "darwin" });
    expect(await probe.sampleProcessTrees([100])).toBeUndefined();
    expect(await probe.sampleProcessTrees([100])).toBeUndefined();
    shouldFail = false;
    expect(await probe.sampleProcessTrees([100])).toEqual(
      new Map([[100, [{ pid: 100, rssKb: 50, cpuTimeMs: 1_000 }]]]),
    );
    shouldFail = true;
    expect(await probe.sampleProcessTrees([100])).toBeUndefined();
    expect(await probe.sampleProcessTrees([100])).toBeUndefined();
    expect(await probe.sampleProcessTrees([100])).toBeUndefined();

    expect(execFile).toHaveBeenCalledTimes(6);
  });

  it("每次失败都把原因交给观测回调", async () => {
    const onSampleFailed = vi.fn();
    const probe = createProcessProbe({
      execFile: async () => ({ status: 1, stderr: "ps: 权限不足", stdout: "" }),
      onSampleFailed,
      platform: "darwin",
    });

    expect(await probe.sampleProcessTrees([100])).toBeUndefined();

    expect(onSampleFailed).toHaveBeenCalledOnce();
    expect(String(onSampleFailed.mock.calls[0]?.[0])).toContain("权限不足");
  });

  it("Linux /proc 扫描超时后不再发起剩余批次", async () => {
    const pids = Array.from({ length: 400 }, (_, index) => index + 100);
    let elapsedMs = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => elapsedMs);
    const readProcFile = vi.fn(async () => {
      // 每次读推进 20 毫秒虚拟时间，一定会在扫完 400 个 pid 前撞上 1 秒预算。
      elapsedMs += 20;
      return "";
    });

    const probe = createProcessProbe({
      listProcDirectory: async () => pids.map(String),
      platform: "linux",
      readProcFile,
    });

    expect(await probe.sampleProcessTrees([100])).toBeUndefined();
    // 批次边界检查预算：读取次数远小于 pid 总数，超时后没有继续吃 IO。
    expect(readProcFile.mock.calls.length).toBeLessThan(pids.length);
    nowSpy.mockRestore();
  });

  it("treeScope 由探针自报，调用方不用判平台", () => {
    expect(createProcessProbe({ platform: "darwin" }).treeScope).toBe("process_tree");
    expect(createProcessProbe({ platform: "linux" }).treeScope).toBe("process_tree");
    expect(createProcessProbe({ platform: "win32" }).treeScope).toBe("direct_process");
  });
});
