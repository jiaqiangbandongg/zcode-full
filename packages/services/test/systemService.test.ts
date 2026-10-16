import { describe, expect, it, vi } from "vitest";
import { createSystemService } from "../src/system/systemService.js";

// 探测目标只是被测入参：用保留域名与文档网段 IP，不绑定内网真实地址（开源导出里内网默认地址为空）。
const PROBE_HOST = "intranet-probe.example";
const PROBE_SERVICE_URL = "http://intranet-probe.example:3850/api/intranet/probe";
const SECONDARY_PROBE_IP = "192.0.2.151";

describe("systemService", () => {
  it("info 会返回当前平台和 home 目录", async () => {
    const service = createSystemService();
    const info = await service.info();

    expect(info.platform).toBe(process.platform);
    expect(typeof info.homedir).toBe("string");
    expect(info.homedir.length).toBeGreaterThan(0);
  });

  it("listIntegratedTerminalShells 在非 Windows host 返回空列表", async () => {
    const service = createSystemService({ platform: "darwin" });

    await expect(service.listIntegratedTerminalShells()).resolves.toEqual([]);
  });

  it("listIntegratedTerminalShells 在 Windows host 返回 cmd 和可用的 Git Bash", async () => {
    const service = createSystemService({
      env: {
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
        PATH: "C:\\Program Files\\Git\\cmd",
      },
      isExecutable: (path) =>
        [
          "C:\\Windows\\System32\\cmd.exe",
          "C:\\Program Files\\Git\\bin\\bash.exe",
        ].includes(path),
      platform: "win32",
    });

    await expect(service.listIntegratedTerminalShells()).resolves.toEqual([
      {
        dialect: "cmd",
        id: "cmd:C:\\Windows\\System32\\cmd.exe",
        label: "CMD",
        path: "C:\\Windows\\System32\\cmd.exe",
        source: "system",
      },
      {
        dialect: "git-bash",
        id: "git-bash:C:\\Program Files\\Git\\bin\\bash.exe",
        label: "Git Bash",
        path: "C:\\Program Files\\Git\\bin\\bash.exe",
        source: "system",
      },
    ]);
  });

  it("listIntegratedTerminalShells 按 Windows 大小写无关语义读取 PATH 和 ComSpec", async () => {
    const service = createSystemService({
      env: {
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
        Path: "D:\\Tools\\Git\\cmd",
      },
      isExecutable: (path) =>
        [
          "D:\\Tools\\Git\\cmd\\git.exe",
          "D:\\Tools\\Git\\bin\\bash.exe",
        ].includes(path),
      platform: "win32",
    });

    await expect(service.listIntegratedTerminalShells()).resolves.toEqual([
      {
        dialect: "cmd",
        id: "cmd:C:\\Windows\\System32\\cmd.exe",
        label: "CMD",
        path: "C:\\Windows\\System32\\cmd.exe",
        source: "system",
      },
      {
        dialect: "git-bash",
        id: "git-bash:D:\\Tools\\Git\\bin\\bash.exe",
        label: "Git Bash",
        path: "D:\\Tools\\Git\\bin\\bash.exe",
        source: "path",
      },
    ]);
  });

  it("listIntegratedTerminalShells 在缺少 ComSpec 时展示 CMD fallback", async () => {
    const service = createSystemService({
      env: {},
      isExecutable: () => false,
      platform: "win32",
    });

    await expect(service.listIntegratedTerminalShells()).resolves.toEqual([
      {
        dialect: "cmd",
        id: "cmd:cmd.exe",
        label: "CMD",
        path: "cmd.exe",
        source: "system",
      },
    ]);
  });

  it("probeIntranet 只要命中一个探测目标就会判定为内网", async () => {
    const tcpProbe = vi
      .fn<(
        params: {
          host: string;
          port: number;
          timeoutMs: number;
        },
      ) => Promise<number>>()
      .mockImplementationOnce(async () => 23);
    const service = createSystemService({ tcpProbe, now: () => 1700000000000 });

    const result = await service.probeIntranet({
      targets: [{ host: PROBE_HOST, port: 22 }],
    });

    expect(tcpProbe).toHaveBeenCalledWith({
      host: PROBE_HOST,
      port: 22,
      timeoutMs: 800,
    });
    expect(result).toMatchObject({
      isIntranet: true,
      reachedTargetCount: 1,
      requiredSuccessCount: 1,
      totalTargets: 1,
      checkedAt: 1700000000000,
    });
    expect(result.results).toEqual([
      {
        targetId: `${PROBE_HOST}:22`,
        kind: "tcp",
        host: PROBE_HOST,
        port: 22,
        reachable: true,
        attemptCount: 1,
        latencyMs: 23,
      },
    ]);
  });

  it("probeIntranet 会按 attempts 重试并在达到阈值前保持 false", async () => {
    const hostCallCount = new Map<string, number>();
    const tcpProbe = vi.fn<
      (
        params: {
          host: string;
          port: number;
          timeoutMs: number;
        },
      ) => Promise<number>
    >(async ({ host }) => {
      const nextCount = (hostCallCount.get(host) ?? 0) + 1;
      hostCallCount.set(host, nextCount);

      if (host === PROBE_HOST) {
        if (nextCount === 1) {
          throw new Error("ECONNREFUSED");
        }
        return 31;
      }

      throw new Error("timeout");
    });

    const service = createSystemService({ tcpProbe, now: () => 1700000001000 });
    const result = await service.probeIntranet({
      attempts: 2,
      requiredSuccessCount: 2,
      targets: [
        { host: PROBE_HOST, port: 22 },
        { host: SECONDARY_PROBE_IP, port: 22, timeoutMs: 400 },
      ],
    });

    expect(tcpProbe).toHaveBeenCalledTimes(4);
    const calls = tcpProbe.mock.calls.map(([params]) => params);
    expect(calls.filter((item) => item.host === PROBE_HOST)).toEqual([
      {
        host: PROBE_HOST,
        port: 22,
        timeoutMs: 800,
      },
      {
        host: PROBE_HOST,
        port: 22,
        timeoutMs: 800,
      },
    ]);
    expect(calls.filter((item) => item.host === SECONDARY_PROBE_IP)).toEqual([
      {
        host: SECONDARY_PROBE_IP,
        port: 22,
        timeoutMs: 400,
      },
      {
        host: SECONDARY_PROBE_IP,
        port: 22,
        timeoutMs: 400,
      },
    ]);

    expect(result).toMatchObject({
      isIntranet: false,
      reachedTargetCount: 1,
      requiredSuccessCount: 2,
      totalTargets: 2,
    });
    expect(result.results).toEqual([
      {
        targetId: `${PROBE_HOST}:22`,
        kind: "tcp",
        host: PROBE_HOST,
        port: 22,
        reachable: true,
        attemptCount: 2,
        latencyMs: 31,
      },
      {
        targetId: `${SECONDARY_PROBE_IP}:22`,
        kind: "tcp",
        host: SECONDARY_PROBE_IP,
        port: 22,
        reachable: false,
        attemptCount: 2,
        latencyMs: null,
        error: "timeout",
      },
    ]);
  });

  it("probeIntranet 支持基于内网服务的 marker 探测", async () => {
    const serviceProbe = vi
      .fn<(
        params: {
          url: string;
          timeoutMs: number;
          token?: string;
        },
      ) => Promise<{ latencyMs: number; marker?: string }>>()
      .mockResolvedValueOnce({
        latencyMs: 19,
        marker: "zcode-intranet-lab",
      });
    const service = createSystemService({
      serviceProbe,
      now: () => 1700000002000,
    });

    const result = await service.probeIntranet({
      targets: [
        {
          kind: "service",
          url: PROBE_SERVICE_URL,
          expectedMarker: "zcode-intranet-lab",
        },
      ],
    });

    expect(serviceProbe).toHaveBeenCalledWith({
      url: PROBE_SERVICE_URL,
      timeoutMs: 800,
    });
    expect(result).toMatchObject({
      isIntranet: true,
      strategy: "service-http",
      reachedTargetCount: 1,
      requiredSuccessCount: 1,
      totalTargets: 1,
      checkedAt: 1700000002000,
    });
    expect(result.results).toEqual([
      {
        targetId: PROBE_SERVICE_URL,
        kind: "service",
        url: PROBE_SERVICE_URL,
        reachable: true,
        attemptCount: 1,
        latencyMs: 19,
        marker: "zcode-intranet-lab",
      },
    ]);
  });

  it("probeIntranet 在 marker 不匹配时会判定失败", async () => {
    const serviceProbe = vi
      .fn<(
        params: {
          url: string;
          timeoutMs: number;
          token?: string;
        },
      ) => Promise<{ latencyMs: number; marker?: string }>>()
      .mockResolvedValue({
        latencyMs: 12,
        marker: "wrong-marker",
      });
    const service = createSystemService({
      serviceProbe,
      now: () => 1700000003000,
    });

    const result = await service.probeIntranet({
      attempts: 2,
      targets: [
        {
          kind: "service",
          url: PROBE_SERVICE_URL,
          expectedMarker: "expected-marker",
        },
      ],
    });

    expect(serviceProbe).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      isIntranet: false,
      strategy: "service-http",
      reachedTargetCount: 0,
      requiredSuccessCount: 1,
      totalTargets: 1,
      checkedAt: 1700000003000,
    });
    expect(result.results).toEqual([
      {
        targetId: PROBE_SERVICE_URL,
        kind: "service",
        url: PROBE_SERVICE_URL,
        reachable: false,
        attemptCount: 2,
        latencyMs: null,
        error: "marker mismatch(expected=expected-marker, actual=wrong-marker)",
      },
    ]);
  });
});
