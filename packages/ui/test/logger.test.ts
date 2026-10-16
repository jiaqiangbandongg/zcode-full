import { afterEach, describe, expect, it, vi } from "vitest";

async function importLogger() {
  vi.resetModules();
  return import("../src/logger.js");
}

describe("ui logger", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps console and desktop bridge logging in non-production builds", async () => {
    vi.stubEnv("PROD", false);
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleDebug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const bridgeLog = vi.fn();
    vi.stubGlobal("window", { zcode: { log: bridgeLog } });

    const { isLoggerLevelEnabled, logger } = await importLogger();

    expect(isLoggerLevelEnabled("debug")).toBe(true);
    expect(isLoggerLevelEnabled("info")).toBe(true);
    logger.info("visible", { id: "info-1" });
    logger.debug("debug-only");

    expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining("[ui]"), "visible", {
      id: "info-1",
    });
    expect(consoleDebug).toHaveBeenCalledWith(expect.stringContaining("[ui]"), "debug-only");
    expect(bridgeLog).toHaveBeenCalledTimes(1);
    expect(bridgeLog).toHaveBeenCalledWith("info", ["visible", { id: "info-1" }]);
  });

  it("does not touch console or desktop bridge in production builds", async () => {
    vi.stubGlobal("__ZCODE_RENDERER_DISABLE_LOGGING__", true);
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleDebug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const bridgeLog = vi.fn();
    vi.stubGlobal("window", { zcode: { log: bridgeLog } });

    const { isLoggerLevelEnabled, logger } = await importLogger();

    expect(isLoggerLevelEnabled("debug")).toBe(false);
    expect(isLoggerLevelEnabled("info")).toBe(false);
    logger.debug("hidden-debug");
    logger.info("hidden-info");
    logger.warn("hidden-warn");
    logger.error("hidden-error");
    logger.trace("trace-1", "error", "hidden-trace");

    expect(consoleDebug).not.toHaveBeenCalled();
    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    expect(bridgeLog).not.toHaveBeenCalled();
  });

  it("forwards lifecycle diagnostics to the desktop bridge in production builds", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const bridgeLog = vi.fn();
    vi.stubGlobal("window", { zcode: { log: bridgeLog } });

    const { logger } = await importLogger();

    logger.info("ordinary info must stay disabled");
    logger.lifecycle.info("v4 subscription started", {
      event: "v4.conversation.subscribe.started",
      sessionId: "sess-1",
    });

    expect(consoleLog).not.toHaveBeenCalled();
    expect(bridgeLog).toHaveBeenCalledTimes(1);
    expect(bridgeLog).toHaveBeenCalledWith("info", [
      "v4 subscription started",
      {
        event: "v4.conversation.subscribe.started",
        sessionId: "sess-1",
      },
    ]);
  });
});
