import { describe, expect, it } from "vitest";
import { resolveProviderNameEditKeyAction } from "@/settings/model-provider-section/InlineEditableProviderCard.js";

describe("model provider name IME input", () => {
  it("中文输入法组词期间按 Enter 不提交名称编辑", () => {
    expect(resolveProviderNameEditKeyAction({ key: "Enter", isComposing: true })).toBeNull();
    expect(
      resolveProviderNameEditKeyAction({
        key: "Enter",
        isComposing: false,
        nativeEvent: { isComposing: true },
      }),
    ).toBeNull();
    expect(
      resolveProviderNameEditKeyAction({
        key: "Enter",
        isComposing: false,
        nativeEvent: { isComposing: false },
        compositionActive: true,
      }),
    ).toBeNull();
  });

  it("非组词状态下仍支持 Enter 提交和 Escape 取消", () => {
    expect(resolveProviderNameEditKeyAction({ key: "Enter", isComposing: false })).toBe("commit");
    expect(resolveProviderNameEditKeyAction({ key: "Escape", isComposing: false })).toBe("cancel");
  });
});
