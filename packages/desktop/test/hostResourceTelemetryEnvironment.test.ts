import { describe, expect, it } from "vitest";
import { resolveResourceTelemetryEnvironmentKey } from "@desktop/host/hostResourceTelemetryEnvironment";

describe("资源遥测运行环境身份", () => {
  it("PRT-034 Server 优先按服务端身份归并别名，输出不包含原地址", () => {
    const first = resolveResourceTelemetryEnvironmentKey(
      { kind: "server", url: "http://private-a:3030" },
      "server-one",
    );
    const alias = resolveResourceTelemetryEnvironmentKey(
      { kind: "server", url: "http://private-b:3030/ws" },
      "server-one",
    );
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).toBe(alias);
    expect(first).not.toBe(
      resolveResourceTelemetryEnvironmentKey(
        { kind: "server", url: "http://private-a:3030" },
        "server-two",
      ),
    );
    expect(first).not.toContain("private");
  });
});
