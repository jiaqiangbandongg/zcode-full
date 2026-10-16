import { describe, expect, it } from "vitest";
import { resolveV4ComposerConfigPickerState } from "@/v4/composer/configPickerState.js";

describe("V4 composer config picker state", () => {
  it("新 picker 接管后忽略旧 picker 迟到的关闭回调", () => {
    let active = resolveV4ComposerConfigPickerState(null, "mode", true);
    active = resolveV4ComposerConfigPickerState(active, "model", true);
    active = resolveV4ComposerConfigPickerState(active, "mode", false);

    expect(active).toBe("model");
    expect(resolveV4ComposerConfigPickerState(active, "model", false)).toBeNull();
  });
});
