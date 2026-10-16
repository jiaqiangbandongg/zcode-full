import { describe, expect, it } from "vitest";
import { hostResponseMessageSchema, zcodeToolExecResourceSchema } from "@zcode/shared";

const sample = {
  platform: "linux",
  toolName: "bash",
  durationMs: 40_000,
  exitKind: "completed",
  treeRssKbPeak: 400,
  treeCpuTimeMs: 12_000,
  sampleCount: 2,
  cliRssKb: 1024,
  systemFreeMemoryKb: 2048,
};

describe("Bash 慢命令通知契约", () => {
  it("随机完成标识在 CLI 与 Host 协议中保留，旧 CLI 缺标识仍可解析", () => {
    const identifiedSample = {
      ...sample,
      completionToken: "d339de88-b4f7-41b1-bf97-65032e318d94",
    };
    expect(zcodeToolExecResourceSchema.parse(identifiedSample)).toEqual(identifiedSample);
    expect(
      hostResponseMessageSchema.parse({
        type: "tool-exec-resource",
        runtimeSurface: "remote",
        sample: identifiedSample,
      }),
    ).toMatchObject({ sample: identifiedSample });
    expect(zcodeToolExecResourceSchema.parse(sample)).toEqual(sample);
  });

  it.each(["", "command-output", "/private/workspace", "12345", "a".repeat(128), null, 123])(
    "拒绝非 UUID 完成标识：%s",
    (completionToken) => {
      expect(zcodeToolExecResourceSchema.safeParse({ ...sample, completionToken }).success).toBe(
        false,
      );
    },
  );

  it("CLI 与 Host 接受有界完成事实，拒绝隐私字段、短命令和非法计数", () => {
    expect(zcodeToolExecResourceSchema.parse(sample)).toEqual(sample);
    expect(
      hostResponseMessageSchema.safeParse({
        type: "tool-exec-resource",
        runtimeSurface: "local",
        sample,
      }).success,
    ).toBe(true);
    for (const extra of [
      { command: "secret" },
      { cwd: "/private" },
      { pid: 1 },
      { durationMs: 14999 },
      { sampleCount: 21 },
      { sampleCount: -1 },
      { cliRssKb: Infinity },
      { treeCpuTimeMs: -1 },
      { toolName: "read" },
    ])
      expect(zcodeToolExecResourceSchema.safeParse({ ...sample, ...extra }).success).toBe(false);
  });
});
