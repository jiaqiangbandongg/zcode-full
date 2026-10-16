import { resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

describe("telemetry service registration", () => {
  // Bugfix: 在 pre-push 全量并发执行时，被测模块初始化触发的 console 输出会通过 RPC 上报到主进程，
  // 偶发出现 "EnvironmentTeardownError: Closing rpc while onUserConsoleLog was pending"，
  // 把单测假红挡住 git push。这里在整份测试文件生命周期内静默 console，避免 afterEach 恢复后还有后台日志。
  beforeAll(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "debug").mockImplementation(() => undefined);

    const originalEmitWarning = process.emitWarning;
    vi.spyOn(process, "emitWarning").mockImplementation(((...args: unknown[]) => {
      const [warning, second] = args;
      const message = warning instanceof Error ? warning.message : String(warning);
      const warningType =
        typeof second === "string"
          ? second
          : typeof second === "object" && second !== null && "type" in second
            ? String((second as { type?: unknown }).type)
            : undefined;

      // Bugfix: Windows/Node 24 动态加载 node:sqlite 时会异步抛 ExperimentalWarning。
      // 这条 warning 会绕过 console spy，并在 Vitest 环境关闭时触发 onUserConsoleLog pending。
      if (warningType === "ExperimentalWarning" && message.includes("SQLite")) {
        return;
      }

      return (originalEmitWarning as (...warningArgs: unknown[]) => void).apply(process, args);
    }) as typeof process.emitWarning);
  });

  it("does not register app-level telemetry in local services", async () => {
    // Bugfix: 这条用例依赖动态 import Node 侧服务装配模块。
    // 在 pre-push 全量并发跑测试时，模块初始化偶发超过默认 5 秒，
    // 之前会被误判成失败并直接挡住 git push。这里放宽单测超时，
    // 保持断言语义不变，只消除环境抖动带来的假红。
    const [{ createLocalServices }, { createServiceDescriptor }] = await Promise.all([
      import("../src/node.js"),
      import("../src/descriptors.js"),
    ]);

    const services = createLocalServices({
      zcodeBuiltinProviderConfigFilePath: resolve(
        import.meta.dirname,
        "../../../config/provider/zcode-builtin.json",
      ),
    });
    const telemetryDescriptor = createServiceDescriptor<{
      reportAppLaunch: unknown;
      reportAppDailyActive: unknown;
    }>("telemetry");
    expect(() => services.get(telemetryDescriptor)).toThrow("Service not registered: telemetry");
  }, 15_000);
});
