import { describe, expect, it } from "vitest";
import type { ZCodeConfigOption } from "@zcode/shared";
import { projectSessionConfigToTaskConfigOptions } from "@/v4/composer/sessionConfigTaskCache.js";

const OPTIONS: ZCodeConfigOption[] = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "e2e-default/default-model",
    options: [
      { value: "e2e-default/default-model", name: "Default" },
      { value: "e2e-vision/vision-model", name: "Vision" },
    ],
  },
  {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: "build",
    options: [{ value: "yolo", name: "YOLO" }],
  },
  {
    id: "thought_level",
    name: "Thought",
    category: "thought_level",
    type: "select",
    currentValue: "max",
    options: [{ value: "high", name: "High" }],
  },
];

describe("projectSessionConfigToTaskConfigOptions", () => {
  it("用 v4 权威 model/mode/thought 更新 task 缓存且保留完整目录", () => {
    const projected = projectSessionConfigToTaskConfigOptions(OPTIONS, {
      provider: "e2e-vision",
      model: "vision-model",
      mode: "yolo",
      thought: "high",
    });

    expect(projected).toHaveLength(OPTIONS.length);
    expect(projected[0]).toMatchObject({
      currentValue: "e2e-vision/vision-model",
      options: OPTIONS[0]?.options,
    });
    expect(projected[1]?.currentValue).toBe("yolo");
    expect(projected[2]?.currentValue).toBe("high");
  });

  it("runtime model 已含 provider 前缀时不会重复拼接", () => {
    const projected = projectSessionConfigToTaskConfigOptions(OPTIONS, {
      provider: "e2e-vision",
      model: "e2e-vision/vision-model",
      mode: "build",
      thought: "",
    });

    expect(projected[0]?.currentValue).toBe("e2e-vision/vision-model");
  });
});
