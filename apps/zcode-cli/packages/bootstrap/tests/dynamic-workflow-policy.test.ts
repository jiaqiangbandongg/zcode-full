import { describe, expect, it } from "vitest";
import { updateDynamicWorkflowPolicy } from "../src/zcode-protocol/dynamic-workflow-policy.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";
import { ZCodeProtocolAgentServer } from "../src/zcode-protocol/server.js";
import { closeSession, createSessionRecordForV4 } from "../src/zcode-protocol/server-operations.js";
import { listProtocolSlashCommands } from "../src/zcode-protocol/slash-commands.js";
import type { ZCodeAppOptions } from "../src/app/types.js";
import { createFakeApp } from "./helpers/fake-zcode-app.js";

const workspace = { workspaceKey: "/w", workspacePath: "/w" };

function makeContext() {
  return {
    appRuntimePreferences: {
      askUserQuestionAutoResolutionEnabled: true,
      modelIoFullRetentionEnabled: false,
      offPeakToolEnabled: false,
      dynamicWorkflowEnabled: false,
    },
  } as unknown as ZCodeProtocolAgentServerContext;
}

describe("workspace/updateDynamicWorkflowPolicy（灰度门 workspace 级事实）", () => {
  it("缓存 host 判定供后续 create/resume/v4 冷恢复读取，并回显结果", async () => {
    const context = makeContext();
    const result = await updateDynamicWorkflowPolicy(context, { workspace, enabled: true });
    expect(context.appRuntimePreferences.dynamicWorkflowEnabled).toBe(true);
    expect(result).toEqual({ workspace, enabled: true });

    await updateDynamicWorkflowPolicy(context, { workspace, enabled: false });
    expect(context.appRuntimePreferences.dynamicWorkflowEnabled).toBe(false);
  });

  // launch.md「On demand: activation」「How the mode travels」：mode 与布尔同行；关闭时清掉。
  it("mode 随布尔缓存；关闭时清空，免得旧 Host 只发布尔时沿用过期的 onDemand", async () => {
    const context = makeContext();
    await updateDynamicWorkflowPolicy(context, { workspace, enabled: true, mode: "onDemand" });
    expect(context.appRuntimePreferences.dynamicWorkflowMode).toBe("onDemand");
    await updateDynamicWorkflowPolicy(context, { workspace, enabled: false, mode: "onDemand" });
    expect(context.appRuntimePreferences.dynamicWorkflowMode).toBeUndefined();
    await updateDynamicWorkflowPolicy(context, { workspace, enabled: true });
    expect(context.appRuntimePreferences.dynamicWorkflowMode).toBeUndefined();
  });

  it("mode 只认三个取值", async () => {
    await expect(
      updateDynamicWorkflowPolicy(makeContext(), { workspace, enabled: true, mode: "sometimes" }),
    ).rejects.toThrow();
  });

  it("strict schema 拒绝未知键（不让 host 误传 per-session 字段）", async () => {
    await expect(
      updateDynamicWorkflowPolicy(makeContext(), { workspace, enabled: true, sessionId: "s1" }),
    ).rejects.toThrow();
  });
});

/**
 * DWG-03 的协议服务端一半：session 创建时把灰度结论写成 runtimeConfig 上的**显式布尔**。
 * 缺省是 false（fail-closed）——不认识该方法的旧 Host 不会意外拿到工具面。
 */
describe("session 创建：runtimeConfig.dynamicWorkflowEnabled", () => {
  async function createdRuntimeGate(params: {
    dynamicWorkflowEnabled?: boolean;
    dynamicWorkflowMode?: "disabled" | "onDemand" | "alwaysOn";
    preference?: boolean;
    preferenceMode?: "disabled" | "onDemand" | "alwaysOn";
  }): Promise<{ enabled: boolean | undefined; onDemand: boolean | undefined }> {
    let appOptions: ZCodeAppOptions | undefined;
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => {
        appOptions = options;
        return createFakeApp(options);
      },
    });
    const context = (server as unknown as { context: ZCodeProtocolAgentServerContext }).context;
    if (params.preference !== undefined) {
      await updateDynamicWorkflowPolicy(context, {
        workspace,
        enabled: params.preference,
        ...(params.preferenceMode === undefined ? {} : { mode: params.preferenceMode }),
      });
    }
    const created = await createSessionRecordForV4(context, {
      workspace: { workspacePath: "/fixture", workspaceKey: "/fixture" },
      ...(params.dynamicWorkflowEnabled === undefined
        ? {}
        : { dynamicWorkflowEnabled: params.dynamicWorkflowEnabled }),
      ...(params.dynamicWorkflowMode === undefined
        ? {}
        : { dynamicWorkflowMode: params.dynamicWorkflowMode }),
    });
    try {
      return {
        enabled: appOptions?.runtimeConfig?.dynamicWorkflowEnabled,
        onDemand: appOptions?.runtimeConfig?.dynamicWorkflowToolsOnDemand,
      };
    } finally {
      await closeSession(context, { sessionId: created.sessionId });
    }
  }

  it.each([
    { params: {}, expected: false },
    { params: { dynamicWorkflowEnabled: true }, expected: true },
    { params: { preference: true }, expected: true },
    // per-session 显式 true 与 workspace 结论是或的关系（与 off-peak 同款）。
    { params: { dynamicWorkflowEnabled: true, preference: false }, expected: true },
    { params: { dynamicWorkflowEnabled: false, preference: true }, expected: true },
  ])("%j", async ({ params, expected }) => {
    await expect(createdRuntimeGate(params)).resolves.toMatchObject({ enabled: expected });
  });

  // launch.md「On demand: activation」「How the mode travels」：mode 同序取值——本次参数优先，
  // 再读 workspace 结论，都缺席按 alwaysOn；两个字段都必须是显式布尔。
  it.each([
    { params: {}, expected: { enabled: false, onDemand: false } },
    { params: { dynamicWorkflowEnabled: true }, expected: { enabled: true, onDemand: false } },
    {
      params: { dynamicWorkflowEnabled: true, dynamicWorkflowMode: "onDemand" as const },
      expected: { enabled: true, onDemand: true },
    },
    {
      params: { dynamicWorkflowEnabled: true, dynamicWorkflowMode: "alwaysOn" as const },
      expected: { enabled: true, onDemand: false },
    },
    {
      params: { preference: true, preferenceMode: "onDemand" as const },
      expected: { enabled: true, onDemand: true },
    },
    // 参数只带布尔、workspace 结论带 mode：mode 从 workspace 结论补上。
    {
      params: {
        dynamicWorkflowEnabled: true,
        preference: true,
        preferenceMode: "onDemand" as const,
      },
      expected: { enabled: true, onDemand: true },
    },
    // 本次参数的 mode 优先于 workspace 结论。
    {
      params: {
        dynamicWorkflowEnabled: true,
        dynamicWorkflowMode: "alwaysOn" as const,
        preference: true,
        preferenceMode: "onDemand" as const,
      },
      expected: { enabled: true, onDemand: false },
    },
    // 关闭时按需标志也必须是 false，不能悬空。
    {
      params: { dynamicWorkflowMode: "onDemand" as const },
      expected: { enabled: false, onDemand: false },
    },
  ])("mode 推导 %j", async ({ params, expected }) => {
    await expect(createdRuntimeGate(params)).resolves.toEqual(expected);
  });
});

describe("`/` 目录：灰度关闭时没有 workflow", () => {
  it("关闭剔除、开启保留并紧随 goal 之后（内置命令，不依赖任何插件）", async () => {
    const options = {
      env: { ZCODE_ENV: "test" },
      skipUserConfig: true,
      workingDirectory: process.cwd(),
    };
    const disabled = await listProtocolSlashCommands({
      ...options,
      dynamicWorkflowEnabled: false,
    });
    expect(disabled.some((command) => command.name === "workflow")).toBe(false);
    // 反向断言：只剃 workflow，其余内置命令不受影响。
    expect(disabled.some((command) => command.name === "goal")).toBe(true);

    const enabled = await listProtocolSlashCommands({
      ...options,
      dynamicWorkflowEnabled: true,
    });
    const names = enabled.map((command) => command.name);
    expect(names.indexOf("workflow")).toBe(names.indexOf("goal") + 1);
    expect(enabled.find((command) => command.name === "workflow")?.source).toBe("builtin");
  });
});
