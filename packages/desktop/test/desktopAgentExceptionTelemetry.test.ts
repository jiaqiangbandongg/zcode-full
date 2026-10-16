import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostAgentProcessExceptionResponse } from "@zcode/shared";

const { sendEvent, sendCustom } = vi.hoisted(() => ({ sendEvent: vi.fn(), sendCustom: vi.fn() }));
vi.mock("@arms/rum-electron", () => ({ default: { sendEvent, sendCustom, setConfig: vi.fn() } }));
vi.mock("electron", () => ({ BrowserWindow: {} }));
vi.mock("../src/main/desktopCrashCapture.js", () => ({ registerCrashEventMonitor: vi.fn() }));
vi.mock("../src/main/resourceManagerWindow.js", () => ({ getResourceManagerWindowId: vi.fn() }));

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const event: HostAgentProcessExceptionResponse = {
  type: "agent-process-exception",
  pid: 42,
  provider: "glm",
  lane: "mcp-status",
  workspacePath: "/Users/alice/repo",
  runtimeGeneration: 1,
  runtimeInstanceId: "agent-test",
  diagnostic: {
    version: 1,
    errorId: "1f51b7dc-c52a-46ad-bc97-d2f984e6e3de",
    kind: "uncaughtException",
    origin: "uncaughtException",
    name: "TypeError",
    message: "boom token=secret sk-1234567890abcdefghijklmnopqrstuv /Users/alice/repo",
    stack:
      "TypeError: boom\n    at run (/Users/alice/repo/cli.js:1:2)\n    at next (C:\\Users\\alice\\lib.js:3:4)",
    occurredAt: 123456,
  },
};

async function telemetry() {
  const module = await import("../src/main/desktopStabilityTelemetry.js");
  module.configureDesktopStabilityTelemetry({
    deviceMid: "probe-device",
    platform: "darwin",
    appVersion: "test-version",
    armsEnv: "local",
  });
  return module;
}

describe("Agent JS exception telemetry", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    sendEvent.mockReset();
  });

  it("reports an exception with stack and runtime attribution without waiting for exit", async () => {
    const { reportAgentProcessExceptionToArms } = await telemetry();
    reportAgentProcessExceptionToArms(event, logger);
    expect(sendEvent).toHaveBeenCalledOnce();
    const payload = sendEvent.mock.calls[0]![0];
    expect(payload).toMatchObject({
      event_type: "exception",
      type: "error",
      source: "uncaughtException",
      name: "TypeError",
      timestamp: 123456,
      properties: {
        process_role: "agent",
        error_id: event.diagnostic.errorId,
        runtime_instance_id: "agent-test",
        runtime_generation: "1",
        process_error_origin: "uncaughtException",
        lane: "mcp-status",
        app_version: "test-version",
        arms_env: "local",
        device_mid: "probe-device",
      },
    });
    expect(payload.stack).toContain("at run (<workspace>/cli.js:1:2)");
    expect(payload.stack).toContain("<home>");
    for (const secret of [
      "alice",
      "token=secret",
      "sk-1234567890abcdefghijklmnopqrstuv",
      "workspacePath",
    ]) {
      expect(JSON.stringify(payload)).not.toContain(secret);
    }
    expect(sendCustom).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("deduplicates an occurrence, while preserving repeated errors and different runtimes", async () => {
    const { reportAgentProcessExceptionToArms } = await telemetry();
    reportAgentProcessExceptionToArms(event, logger);
    reportAgentProcessExceptionToArms(event, logger);
    reportAgentProcessExceptionToArms({ ...event, runtimeInstanceId: "agent-other" }, logger);
    reportAgentProcessExceptionToArms(
      {
        ...event,
        diagnostic: {
          ...event.diagnostic,
          errorId: "2f51b7dc-c52a-46ad-bc97-d2f984e6e3de",
          kind: "unhandledRejection",
          origin: "unhandledRejection",
        },
      },
      logger,
    );
    expect(sendEvent).toHaveBeenCalledTimes(3);
    expect(sendEvent.mock.calls[2]?.[0].source).toBe("unhandledRejection");
  });

  it("bounds details and does not mark failed submissions as delivered", async () => {
    const { reportAgentProcessExceptionToArms } = await telemetry();
    sendEvent.mockImplementationOnce(() => {
      throw new Error("SDK unavailable");
    });
    const longEvent = { ...event, diagnostic: { ...event.diagnostic, stack: "x".repeat(16_000) } };
    expect(() => reportAgentProcessExceptionToArms(longEvent, logger)).not.toThrow();
    reportAgentProcessExceptionToArms(longEvent, logger);
    expect(sendEvent).toHaveBeenCalledTimes(2);
    expect(sendEvent.mock.calls[1]?.[0].stack).toHaveLength(4000);
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("keeps only a bounded dedup history", async () => {
    const { reportAgentProcessExceptionToArms } = await telemetry();
    for (let i = 0; i <= 1024; i++) {
      reportAgentProcessExceptionToArms({ ...event, runtimeInstanceId: `agent-${i}` }, logger);
    }
    reportAgentProcessExceptionToArms({ ...event, runtimeInstanceId: "agent-1024" }, logger);
    expect(sendEvent).toHaveBeenCalledTimes(1025);
    reportAgentProcessExceptionToArms({ ...event, runtimeInstanceId: "agent-0" }, logger);
    expect(sendEvent).toHaveBeenCalledTimes(1026);
  });
});
