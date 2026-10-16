import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessagePortLike } from "@zcode/rpc";

async function importClientLogger() {
  vi.resetModules();
  return import("../src/logger.js");
}

async function importMessagePort() {
  vi.resetModules();
  return import("../src/messageport.js");
}

class FakeMessagePort implements MessagePortLike {
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  postMessage = vi.fn();
  start = vi.fn();
  close = vi.fn();
}

describe("client renderer logging", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps client renderer logger active in non-production builds", async () => {
    vi.stubEnv("PROD", false);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bridgeLog = vi.fn();
    vi.stubGlobal("window", { zcode: { log: bridgeLog } });

    const { logger } = await importClientLogger();

    logger.warn("visible", { id: "client-warn" });

    expect(consoleWarn).toHaveBeenCalledWith(
      expect.stringContaining("[renderer]"),
      "visible",
      { id: "client-warn" },
    );
    expect(bridgeLog).toHaveBeenCalledWith("warn", ["visible", { id: "client-warn" }]);
  });

  it("does not log through client renderer logger in production builds", async () => {
    vi.stubGlobal("__ZCODE_RENDERER_DISABLE_LOGGING__", true);
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const bridgeLog = vi.fn();
    vi.stubGlobal("window", { zcode: { log: bridgeLog } });

    const { logger } = await importClientLogger();

    logger.info("hidden-info");
    logger.warn("hidden-warn");
    logger.error("hidden-error");

    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    expect(bridgeLog).not.toHaveBeenCalled();
  });

  it("does not emit MessagePort startup logs in production builds", async () => {
    vi.stubGlobal("__ZCODE_RENDERER_DISABLE_LOGGING__", true);
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const { connectViaMessagePort } = await importMessagePort();

    connectViaMessagePort(new FakeMessagePort());

    expect(consoleLog).not.toHaveBeenCalled();
  });

  it("exposes an idempotent disposer for scoped MessagePort services", async () => {
    const { createMessagePortServiceConnection } = await importMessagePort();
    const port = new FakeMessagePort();
    const connection = createMessagePortServiceConnection(port);
    const reason = new Error("remote connection closed");

    connection.dispose(reason);
    connection.dispose();

    expect(connection.services).toBeDefined();
    expect(port.close).toHaveBeenCalledTimes(1);
  });
});
