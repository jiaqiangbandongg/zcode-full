// workspace-config topic 黄金测试（M5 删波次 2 additive 演进纪律：新增 topic 必须带黄金测试）。
// 覆盖：帧信封 round-trip（snapshot / deltas）、topic key 对偶、载荷与 host 侧
// ZCodeConfigOption / ZCodeSlashCommand 的结构对齐（syncer 零映射直通的前提）。
import { describe, expect, it } from "vitest";
import { zcodeSessionSettingsToZCodeConfigOptions } from "../src/zcode-agent-model-state.js";
import type { ZCodeSessionSettingsState } from "../src/zcode-protocol/index.js";
import type { ZCodeConfigOption, ZCodeSlashCommand } from "../src/zcode-task-types-core.js";
import {
  parseWorkspaceConfigTopic,
  workspaceConfigSnapshotSchema,
  workspaceConfigStateSchema,
  workspaceConfigTopic,
  workspaceConfigTopicFrameSchema,
  type WorkspaceConfigState,
} from "../src/zcode-protocol-v4/index.js";

const goldenState = {
  configOptions: [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select" as const,
      currentValue: "anthropic/haiku-4.5",
      options: [
        {
          value: "anthropic/haiku-4.5",
          name: "Haiku 4.5",
          description: "fast",
          modelProviderId: "anthropic",
          modelProviderName: "Anthropic",
          modelThoughtLevels: ["low", "medium", "high", "xhigh"],
          modelDefaultThoughtLevel: "medium",
        },
      ],
    },
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select" as const,
      currentValue: "build",
      options: [{ value: "build", name: "Ask before changes" }],
    },
  ],
  slashCommands: [
    { name: "compact", description: "Compact the session", source: "builtin" as const },
    { name: "goal", description: "Run toward a goal", inputHint: "<objective>" },
  ],
};

describe("zcode-protocol-v4 workspace-config topic", () => {
  it("topic key 构造与解析对偶", () => {
    expect(workspaceConfigTopic("/repo")).toBe("workspace-config//repo");
    expect(parseWorkspaceConfigTopic(workspaceConfigTopic("/repo"))).toBe("/repo");
    expect(parseWorkspaceConfigTopic("workspace-config/")).toBeNull();
    expect(parseWorkspaceConfigTopic("sessions-index//repo")).toBeNull();
  });

  it("snapshot 帧 round-trip（fromSeq 固定 0）", () => {
    const frame = {
      topic: workspaceConfigTopic("/repo"),
      subscriptionId: "wcs-epoch-1",
      fromSeq: 0,
      toSeq: 3,
      sentAt: 1000,
      payload: {
        kind: "snapshot" as const,
        snapshot: {
          protocolVersion: 1 as const,
          workspaceId: "/repo",
          logEpoch: "epoch-a",
          config: goldenState,
        },
      },
    };
    const parsed = workspaceConfigTopicFrameSchema.parse(frame);
    expect(parsed).toEqual(frame);
  });

  it("deltas 帧 round-trip（config.updated 整体替换）", () => {
    const frame = {
      topic: workspaceConfigTopic("/repo"),
      subscriptionId: "wcs-epoch-2",
      fromSeq: 3,
      toSeq: 4,
      sentAt: 2000,
      payload: {
        kind: "deltas" as const,
        deltas: [{ op: "config.updated" as const, config: goldenState }],
      },
    };
    const parsed = workspaceConfigTopicFrameSchema.parse(frame);
    expect(parsed).toEqual(frame);
  });

  it("拒绝未知 delta op / 非法 snapshot", () => {
    expect(
      workspaceConfigTopicFrameSchema.safeParse({
        topic: "workspace-config//repo",
        subscriptionId: "s",
        fromSeq: 0,
        toSeq: 1,
        sentAt: 1,
        payload: { kind: "deltas", deltas: [{ op: "config.patched", config: goldenState }] },
      }).success,
    ).toBe(false);
    expect(
      workspaceConfigSnapshotSchema.safeParse({
        protocolVersion: 3,
        workspaceId: "/repo",
        logEpoch: "e",
        config: goldenState,
      }).success,
    ).toBe(false);
  });

  it("载荷与 host 侧 ZCodeConfigOption / ZCodeSlashCommand 结构对齐（零映射直通）", () => {
    const state: WorkspaceConfigState = workspaceConfigStateSchema.parse(goldenState);
    // 类型层面的对齐验证：v4 载荷可以直接赋给 host 侧下游消费类型。
    const configOptions: ZCodeConfigOption[] = state.configOptions;
    const slashCommands: ZCodeSlashCommand[] = state.slashCommands;
    expect(configOptions[0]?.id).toBe("model");
    expect(slashCommands[0]?.name).toBe("compact");
  });

  it("把每个模型的 reasoning 目录投影到 model select value", () => {
    const settings: ZCodeSessionSettingsState = {
      model: {
        current: { providerId: "anthropic", modelId: "claude-opus-4-8" },
        available: [
          {
            ref: { providerId: "anthropic", modelId: "claude-opus-4-8" },
            label: "Claude Opus 4.8",
            reasoning: {
              defaultLevel: "medium",
              levels: [
                { value: "low", label: "low" },
                { value: "medium", label: "medium" },
                { value: "high", label: "high" },
                { value: "xhigh", label: "xhigh" },
              ],
            },
          },
          {
            ref: { providerId: "anthropic", modelId: "plain-chat" },
            label: "Plain Chat",
            reasoning: { levels: [] },
          },
          {
            ref: { providerId: "anthropic", modelId: "legacy-model" },
            label: "Legacy Model",
          },
        ],
      },
      thoughtLevel: { enabled: true, available: [], current: undefined },
      mode: { current: "build" },
    };

    const modelOption = zcodeSessionSettingsToZCodeConfigOptions(settings).find(
      (option) => option.id === "model",
    );

    expect(modelOption?.options).toEqual([
      expect.objectContaining({
        value: "anthropic/claude-opus-4-8",
        modelThoughtLevels: ["low", "medium", "high", "xhigh"],
        modelDefaultThoughtLevel: "medium",
      }),
      expect.objectContaining({
        value: "anthropic/plain-chat",
        modelThoughtLevels: [],
      }),
      expect.not.objectContaining({ modelThoughtLevels: expect.anything() }),
    ]);
  });
});
