import { describe, expect, it } from "vitest";
import { formatModelPickerValue, zcodeSessionSettingsStateSchema } from "../src/index.js";

describe("未绑定模型的协议与显示边界", () => {
  it("允许 settings 没有当前模型，不用空 Provider/Model 冒充有效身份", () => {
    const settings = {
      model: { available: [] },
      thoughtLevel: { enabled: false, available: [] },
      mode: { current: "build" },
    };
    expect(zcodeSessionSettingsStateSchema.parse(settings).model.current).toBeUndefined();
    expect(
      zcodeSessionSettingsStateSchema.safeParse({
        ...settings,
        model: { ...settings.model, current: { providerId: "", modelId: "" } },
      }).success,
    ).toBe(false);
  });

  it("模型控件的空选择显示为空，实际选择仍保留完整编码", () => {
    expect(formatModelPickerValue(undefined)).toBe("");
    expect(formatModelPickerValue({ providerId: "p", modelId: "m" })).toBe("p/m");
  });
});
