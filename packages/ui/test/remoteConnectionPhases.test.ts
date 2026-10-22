import { describe, expect, it } from "vitest";
import {
  resolveRemoteConnectionPhases,
  resolveRemoteConnectionPhaseSub,
  resolveRemoteOperationProgress,
} from "@/remote-connection/RemoteConnectionConnectingStep.js";

describe("remote connection phase rail", () => {
  it.each(["verify-archive", "extract", "verify"])(
    "keeps %s in deployment before handshake",
    (stage) => {
      const phases = resolveRemoteConnectionPhases([
        { message: `[source-server:${stage}] processing`, level: "info" },
      ]);
      expect(phases.find((phase) => phase.key === "deploy")?.status).toBe("active");
      expect(phases.find((phase) => phase.key === "handshake")?.status).toBe("pending");
    },
  );

  it("moves restart into handshake without reporting readiness", () => {
    const phases = resolveRemoteConnectionPhases([
      { message: "[source-server:verify] checking", level: "info" },
      { message: "[source-server:restart] restarting", level: "info" },
    ]);
    expect(phases.find((phase) => phase.key === "deploy")?.status).toBe("complete");
    expect(phases.find((phase) => phase.key === "handshake")?.status).toBe("active");
    expect(phases.some((phase) => phase.key === "ready")).toBe(false);
  });

  it.each(["verify", "restart"])("preserves a %s failure", (stage) => {
    const phases = resolveRemoteConnectionPhases(
      [{ message: `[source-server:${stage}] failed`, level: "error" }],
      { connectionReady: true },
    );
    expect(
      phases.find((phase) => phase.key === (stage === "restart" ? "handshake" : "deploy"))?.status,
    ).toBe("failed");
    expect(phases.some((phase) => phase.key === "ready")).toBe(false);
  });
  it("projects source-server diagnostic prefixes into ordered progress", () => {
    const phases = resolveRemoteConnectionPhases([
      { message: "[source-server:probe] SSH channel", level: "info" },
      { message: "[source-server:daemon] Starting daemon", level: "info" },
    ]);

    expect(phases.find((phase) => phase.key === "channel")?.status).toBe("complete");
    expect(phases.find((phase) => phase.key === "handshake")?.status).toBe("active");
    expect(phases.some((phase) => phase.key === "ready")).toBe(false);
  });

  it("completes the terminal phase from connection readiness when its log is absent", () => {
    const phases = resolveRemoteConnectionPhases(
      [
        { message: "[source-server:probe] SSH channel", level: "info" },
        { message: "[source-server:daemon] Starting daemon", level: "info" },
      ],
      { connectionReady: true },
    );

    expect(phases.find((phase) => phase.key === "handshake")?.status).toBe("complete");
    expect(phases.some((phase) => phase.key === "ready")).toBe(false);
  });

  it("does not mask a failed phase with a stale readiness flag", () => {
    const phases = resolveRemoteConnectionPhases(
      [
        {
          message: "[source-server:protocol-handshake] rejected",
          level: "error",
        },
      ],
      { connectionReady: true },
    );

    expect(phases.find((phase) => phase.key === "handshake")?.status).toBe("failed");
    expect(phases.some((phase) => phase.key === "ready")).toBe(false);
  });

  it("marks the active phase failed when the connection ends with an error", () => {
    const phases = resolveRemoteConnectionPhases([
      {
        message: "[source-server:protocol-handshake] rejected",
        level: "error",
      },
    ]);

    expect(phases.find((phase) => phase.key === "handshake")?.status).toBe(
      "failed",
    );
  });

  it("keeps deployment progress visible between probe and daemon", () => {
    const phases = resolveRemoteConnectionPhases([
      { message: "[source-server:probe] checked", level: "info" },
      { message: "[source-server:upload] 40%", level: "info" },
    ]);

    expect(phases.find((phase) => phase.key === "deploy")?.status).toBe(
      "active",
    );
    expect(phases.find((phase) => phase.key === "handshake")?.status).toBe(
      "pending",
    );
  });
});

describe("remote connection phase sub copy", () => {
  it("maps structured milestones to prototype sub descriptions", () => {
    expect(
      resolveRemoteConnectionPhaseSub(
        { key: "channel", status: "complete" },
        {},
      ),
    ).toEqual({ id: "remote.phaseSub.channelEstablished" });
    expect(
      resolveRemoteConnectionPhaseSub(
        { key: "identify", status: "complete" },
        { recognizedDeviceName: "dev" },
      ),
    ).toEqual({
      id: "remote.phaseSub.identifyExisting",
      values: { device: "dev" },
    });
    expect(
      resolveRemoteConnectionPhaseSub(
        { key: "identify", status: "complete" },
        { installConfirmationPending: true },
      ),
    ).toEqual({ id: "remote.phaseSub.identifyNew" });
    expect(
      resolveRemoteConnectionPhaseSub(
        { key: "deploy", status: "active" },
        { installConfirmationPending: true },
      ),
    ).toEqual({ id: "remote.phaseSub.deployWaitingConfirm" });
    expect(
      resolveRemoteConnectionPhaseSub(
        { key: "deploy", status: "failed" },
        { deployErrorReason: "SFTP channel closed" },
      ),
    ).toEqual({
      id: "remote.phaseSub.uploadFailed",
      values: { reason: "SFTP channel closed" },
    });
    expect(
      resolveRemoteConnectionPhaseSub({ key: "ready", status: "complete" }, {}),
    ).toEqual({ id: "remote.phaseSub.readyOnline" });
  });

  it("stays empty when no structured data source backs the sub description", () => {
    // 缺结构化数据源的阶段（握手端口、部署版本等）留空，不透传英文原始日志。
    expect(
      resolveRemoteConnectionPhaseSub(
        { key: "handshake", status: "complete" },
        {},
      ),
    ).toBeNull();
    expect(
      resolveRemoteConnectionPhaseSub({ key: "channel", status: "active" }, {}),
    ).toBeNull();
    expect(
      resolveRemoteConnectionPhaseSub({ key: "deploy", status: "active" }, {}),
    ).toBeNull();
  });
});

describe("sidebar operation progress", () => {
  const log = (
    phase: string,
    timestamp: number,
    progress?: number,
    level: "info" | "warn" | "error" = "info",
  ) => ({
    phase,
    timestamp,
    level,
    ...(progress === undefined ? {} : { progress }),
  });

  it("starts at the first phase without elapsed time before any log", () => {
    expect(resolveRemoteOperationProgress([])).toEqual({
      index: 0,
      total: 4,
      titleId: "remote.phase.channel",
    });
  });

  it("shares the wizard phase grouping and reports upload percent", () => {
    expect(
      resolveRemoteOperationProgress([
        log("probe", 1_000),
        log("preflight", 2_000),
        log("upload", 3_000, 0.432),
      ]),
    ).toEqual({
      index: 2,
      total: 4,
      titleId: "remote.phase.deploy",
      percent: 43,
      startedAt: 1_000,
    });
  });

  it("drops the percent once the latest log has no transfer progress", () => {
    expect(
      resolveRemoteOperationProgress([log("upload", 1_000, 0.9), log("extract", 2_000)]).percent,
    ).toBeUndefined();
  });

  it("skips install phases and ignores unknown trailing phases", () => {
    const progress = resolveRemoteOperationProgress([
      log("probe", 1_000),
      log("daemon", 2_000),
      log("cleanup", 3_000, 0.5),
    ]);
    expect(progress).toMatchObject({ index: 3, titleId: "remote.phase.handshake" });
    expect(progress.percent).toBeUndefined();
  });

  it.each([
    { name: "成功结束的上一次连接", tail: log("ready", 3_000, 1) },
    { name: "失败结束的上一次尝试", tail: log("daemon", 3_000, undefined, "error") },
  ])("$name 不再算作进行中：回到第 1 步且不计时", ({ tail }) => {
    // 修复原因：Host 保留的是最近一次操作，断线后首次重试前、两次重试之间读到的都是已结束操作；
    // 曾据此显示“第 4/4 步 · 已用 120 分”。
    expect(resolveRemoteOperationProgress([log("probe", 1_000), log("daemon", 2_000), tail])).toEqual(
      { index: 0, total: 4, titleId: "remote.phase.channel" },
    );
  });
});
