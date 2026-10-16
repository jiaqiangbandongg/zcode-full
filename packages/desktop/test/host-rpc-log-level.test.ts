import { describe, expect, it } from "vitest";
import { resolveRpcLogLevel } from "../src/host/rpcLogLevel.js";

describe("host RPC 日志级别映射", () => {
  it("后台 Bash 成功轮询仅记 debug，失败仍记 warn", () => {
    expect(resolveRpcLogLevel("[rpc:call] zcode-agent.backgroundBashOutputV4 OK (1.5ms)")).toBe(
      "debug",
    );
    expect(resolveRpcLogLevel("[rpc:call] zcode-agent.backgroundBashOutputV4 FAIL (1.5ms)")).toBe(
      "warn",
    );
    expect(
      resolveRpcLogLevel("[rpc:call] zcode-agent.otherBackgroundBashOutputV4 OK (1.5ms)"),
    ).toBe("info");
  });

  it("RPC 成功日志应记为 info", () => {
    expect(resolveRpcLogLevel("[rpc:call] setting.get OK (1.5ms)")).toBe("info");
  });

  it("RPC 失败日志应记为 warn", () => {
    expect(resolveRpcLogLevel("[rpc:call] setting.get FAIL (1.5ms)")).toBe("warn");
  });

  it("provider registry 尚未就绪的 runtime identity 查询应记为 info", () => {
    const error = Object.assign(new Error("provider not ready"), {
      code: "ZCODE_AGENT_PROVIDER_NOT_READY",
    });

    expect(
      resolveRpcLogLevel(
        "[rpc:call] zcode-session.getWorkspaceRuntimeIdentity FAIL (12.0ms)",
        error,
      ),
    ).toBe("info");
  });
});
