import { describe, expect, it } from "vitest";
import {
  SERVER_REMOTE_PROTOCOL_VERSION,
  serverRemoteInfoSchema,
  serverRemoteInfoOutputSchema,
} from "@zcode/shared";

const serverInfo = {
  serverId: "remote-server",
  version: "3.12.0",
  protocolVersion: SERVER_REMOTE_PROTOCOL_VERSION,
  authRequired: false,
  workspaces: [],
  capabilities: { desktopContinuous: true, websocketRpc: true },
};

describe.each([
  ["客户端输入", serverRemoteInfoSchema],
  ["服务端输出", serverRemoteInfoOutputSchema],
] as const)("Server 资源遥测能力协商：%s", (_side, schema) => {
  it("旧 Server 缺少资源能力仍能解析，且不被误判为支持订阅", () => {
    const parsed = schema.parse(serverInfo);
    expect(parsed).toEqual(serverInfo);
    expect(parsed.capabilities.processResourceTelemetry === true).toBe(false);
    expect(parsed.protocolVersion).toBe(1);
  });

  it.each([true, false])("保留 Server 显式声明的资源能力 %s", (supported) => {
    const parsed = schema.parse({
      ...serverInfo,
      capabilities: { ...serverInfo.capabilities, processResourceTelemetry: supported },
    });
    expect(parsed.capabilities.processResourceTelemetry).toBe(supported);
  });

  it("拒绝非布尔能力值，避免把字符串 false 当成授权", () => {
    expect(
      schema.safeParse({
        ...serverInfo,
        capabilities: { ...serverInfo.capabilities, processResourceTelemetry: "false" },
      }).success,
    ).toBe(false);
  });
});

it("服务端允许已声明的资源能力但仍拒绝未知出参", () => {
  expect(
    serverRemoteInfoOutputSchema.safeParse({
      ...serverInfo,
      capabilities: {
        ...serverInfo.capabilities,
        processResourceTelemetry: true,
        undeclaredCapability: true,
      },
    }).success,
  ).toBe(false);
});
