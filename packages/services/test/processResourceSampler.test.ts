import { describe, expect, it } from "vitest";
import {
  attributeHostProcessTree,
  createProcessResourceSampler,
  createProcessResourceTableReader,
  parseCpuTimeText,
  parseDarwinProcessTable,
  parseLinuxProcStat,
  parseLinuxVmRssKb,
  parseWindowsProcessTable,
  type ProcessResourceRow,
  type ProcessResourceSample,
} from "../src/process/processResourceSampler.js";

describe("parseCpuTimeText", () => {
  it("解析 macOS 与 Linux 的 cputime 格式", () => {
    expect(parseCpuTimeText("0:00.12")).toBe(120);
    expect(parseCpuTimeText("12:34.56")).toBe(754_560);
    expect(parseCpuTimeText("1:02:03.45")).toBe(3_723_450);
    expect(parseCpuTimeText("00:00:05")).toBe(5_000);
    expect(parseCpuTimeText("2-01:00:00")).toBe(2 * 86_400_000 + 3_600_000);
    expect(parseCpuTimeText("bogus")).toBeUndefined();
  });
});

describe("process table parsers", () => {
  it.each(["win32", "darwin"] as const)(
    "%s 的取消传给采样命令，已取消时不再启动命令",
    async (platform) => {
      const controller = new AbortController();
      let calls = 0;
      const reader = createProcessResourceTableReader({
        platform,
        execFile: async (_file, _args, options) => {
          calls += 1;
          expect(options.signal).toBe(controller.signal);
          return { stdout: "" };
        },
      });
      await reader(controller.signal);
      controller.abort();
      await expect(reader(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
      expect(calls).toBe(1);
    },
  );
  it("darwin：comm 含空格路径也能解析", () => {
    const rows = parseDarwinProcessTable(
      [
        "  100     1  2048 0:01.50 /Applications/ZCode.app/Contents/MacOS/ZCode",
        "  200   100  4096 0:00.25 /Applications/ZCode.app/Contents/Frameworks/ZCode Helper (Renderer).app/Contents/MacOS/ZCode Helper (Renderer)",
        "garbage line",
      ].join("\n"),
    );
    expect(rows).toEqual([
      {
        pid: 100,
        ppid: 1,
        rssKb: 2048,
        cpuTimeMs: 1_500,
        command: "/Applications/ZCode.app/Contents/MacOS/ZCode",
      },
      {
        pid: 200,
        ppid: 100,
        rssKb: 4096,
        cpuTimeMs: 250,
        command:
          "/Applications/ZCode.app/Contents/Frameworks/ZCode Helper (Renderer).app/Contents/MacOS/ZCode Helper (Renderer)",
      },
    ]);
  });

  it("linux：/proc stat 的 comm 含空格与括号，utime+stime 按 USER_HZ=100 换算", () => {
    expect(
      parseLinuxProcStat(
        "321 (node (agent) x) S 100 321 321 0 -1 4194560 100 0 0 0 150 50 0 0 20 0 1 0 5 1000 2000 18446744073709551615",
      ),
    ).toEqual({ pid: 321, ppid: 100, command: "node (agent) x", cpuTimeMs: 2_000 });
    expect(parseLinuxVmRssKb("Name:\tnode\nVmPeak:\t  1 kB\nVmRSS:\t   5120 kB\n")).toBe(5120);
    expect(parseLinuxVmRssKb("Name:\tkthreadd\n")).toBe(0);
  });

  it("windows：WorkingSet 转 KB，100ns 转毫秒，名称保留", () => {
    expect(parseWindowsProcessTable("1234 100 104857600 15000000 ZCode Helper.exe\r\n")).toEqual([
      { pid: 1234, ppid: 100, rssKb: 102_400, cpuTimeMs: 1_500, command: "ZCode Helper.exe" },
    ]);
  });

  it("linux reader 跳过读取期间退出的进程", async () => {
    const reader = createProcessResourceTableReader({
      platform: "linux",
      readdir: async () => ["1", "2", "self", "cpuinfo"],
      readFile: async (path) => {
        if (path === "/proc/1/stat")
          return "1 (init) S 0 1 1 0 -1 0 0 0 0 0 10 10 0 0 20 0 1 0 1 1 1 1";
        if (path === "/proc/1/status") return "VmRSS:\t 100 kB\n";
        throw new Error("ENOENT");
      },
    });
    expect(await reader()).toEqual([
      { pid: 1, ppid: 0, command: "init", cpuTimeMs: 200, rssKb: 100 },
    ]);
  });

  it("darwin reader 在 ps 失败时返回 undefined 而不是抛错", async () => {
    const reader = createProcessResourceTableReader({
      platform: "darwin",
      execFile: async () => ({ error: new Error("timeout"), stdout: "" }),
    });
    expect(await reader()).toBeUndefined();
  });
});

describe("createProcessResourceSampler", () => {
  it("取消后的迟到读取不更新下一轮 CPU 基线", async () => {
    const controller = new AbortController();
    let calls = 0;
    const sampler = createProcessResourceSampler({
      readTable: async () => {
        calls += 1;
        if (calls === 1) controller.abort();
        return [{ pid: 1, ppid: 0, rssKb: 1, command: "node", cpuTimeMs: calls * 100 }];
      },
      now: () => calls * 1_000,
      logicalCpuCount: 1,
    });
    await expect(sampler.sample(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect((await sampler.sample())?.get(1)?.cpuPercent).toBe(0);
  });
  it("首轮 CPU 为 0，第二轮按 cputime 差分并按逻辑核数归一化", async () => {
    let tick = 0;
    const tables: ProcessResourceRow[][] = [
      [{ pid: 10, ppid: 1, rssKb: 100, cpuTimeMs: 1_000, command: "node" }],
      [{ pid: 10, ppid: 1, rssKb: 120, cpuTimeMs: 1_400, command: "node" }],
      // pid 复用：command 变了 → 重新建立基线
      [{ pid: 10, ppid: 1, rssKb: 50, cpuTimeMs: 5, command: "bash" }],
    ];
    const sampler = createProcessResourceSampler({
      readTable: async () => tables[tick++],
      now: () => tick * 1_000,
      logicalCpuCount: 4,
    });
    expect((await sampler.sample())?.get(10)?.cpuPercent).toBe(0);
    // 400ms CPU / 1000ms wall = 40% 单核 → 整机 4 核 = 10%
    expect((await sampler.sample())?.get(10)).toEqual({
      pid: 10,
      ppid: 1,
      rssKb: 120,
      cpuPercent: 10,
      command: "node",
    });
    expect((await sampler.sample())?.get(10)?.cpuPercent).toBe(0);
  });

  it("进程表读取失败时整轮返回 undefined", async () => {
    const sampler = createProcessResourceSampler({
      readTable: async () => undefined,
      logicalCpuCount: 1,
    });
    expect(await sampler.sample()).toBeUndefined();
  });
});

describe("attributeHostProcessTree", () => {
  function sample(
    pid: number,
    ppid: number,
    command: string,
    cpuPercent = 1,
    rssKb = 1024,
  ): [number, ProcessResourceSample] {
    return [pid, { pid, ppid, rssKb, cpuPercent, command }];
  }

  it("按最近已知祖先把 Host 后代归到 cli / 内置插件 / 社区插件 / host 子进程", () => {
    const samples = new Map<number, ProcessResourceSample>([
      sample(1, 0, "launchd"),
      sample(50, 1, "/Applications/ZCode.app/Contents/MacOS/ZCode"),
      sample(60, 50, "zcode-host"),
      sample(70, 60, "/usr/bin/zsh"), // 终端 shell
      sample(100, 60, "/Applications/ZCode.app/Contents/MacOS/ZCode", 5, 2048), // agent
      sample(110, 100, "/usr/local/bin/pnpm"), // agent 工具子进程
      sample(120, 100, "ZCode Helper (Plugin)"), // 内置插件 MCP 根
      sample(121, 120, "/usr/bin/node"), // 内置插件的孙进程
      sample(130, 100, "/opt/acme/mcp"), // 社区插件 MCP 根
      sample(140, 100, "uvx"), // custom MCP 根
      sample(150, 60, "CUA Helper.exe"), // Host 直管的内置插件进程
      sample(999, 1, "unrelated"),
    ]);
    const rows = attributeHostProcessTree({
      samples,
      hostPid: 60,
      agents: [
        {
          pid: 100,
          provider: "glm",
          workspacePath: "/Users/me/demo",
          children: [
            {
              pid: 120,
              serverName: "plugin:computer-use:computer-use",
              mcpSource: "builtin",
              pluginName: "computer-use",
            },
            { pid: 130, serverName: "plugin:acme:tools", mcpSource: "plugin", pluginName: "acme" },
            { pid: 140, serverName: "my-mcp", mcpSource: "custom" },
          ],
        },
      ],
      builtinPluginPids: new Map([[150, "computer-use"]]),
    });

    expect(rows.map((row) => [row.pid, row.category, row.groupKey, row.name])).toEqual([
      [70, "base", "host", "zsh"],
      [100, "base", "cli", "zcode-agent-glm-demo"],
      [110, "base", "cli", "pnpm"],
      [120, "builtin-plugin", "builtin:computer-use", "plugin:computer-use:computer-use"],
      [121, "builtin-plugin", "builtin:computer-use", "node"],
      [130, "community-plugin", "plugin:acme", "plugin:acme:tools"],
      [140, "community-plugin", "custom:my-mcp", "my-mcp"],
      [150, "builtin-plugin", "computer-use", "CUA Helper"],
    ]);
    expect(rows.find((row) => row.pid === 100)).toMatchObject({
      cpuPercent: 5,
      memoryBytes: 2048 * 1024,
    });
  });

  it("CLI 映射缺失时 Agent 全部后代都归 cli；不在 Host 子树下的 Agent 也补进来", () => {
    const samples = new Map<number, ProcessResourceSample>([
      sample(60, 1, "zcode-host"),
      sample(100, 1, "node"), // ppid 已被重排
      sample(101, 100, "mcp-server"),
    ]);
    const rows = attributeHostProcessTree({
      samples,
      hostPid: 60,
      agents: [{ pid: 100, provider: "glm", workspacePath: "C:\\work\\demo", children: [] }],
    });
    expect(rows.map((row) => [row.pid, row.groupKey, row.name])).toEqual([
      [100, "cli", "zcode-agent-glm-demo"],
      [101, "cli", "mcp-server"],
    ]);
  });
});
