import { describe, expect, it } from "vitest";
import { shouldSlashPanelProcessUpdate } from "@/lib/slashPanelUpdateFilter.js";
import {
  HISTORY_NAVIGATION_UPDATE_TAG,
  PROGRAMMATIC_UPDATE_TAG,
} from "@/lib/editorUpdateTags.js";

describe("shouldSlashPanelProcessUpdate", () => {
  it("普通用户输入时处理更新", () => {
    expect(shouldSlashPanelProcessUpdate(new Set())).toBe(true);
  });

  it("程序化更新（如 setText）时仍处理更新，保持面板响应", () => {
    expect(shouldSlashPanelProcessUpdate(new Set([PROGRAMMATIC_UPDATE_TAG]))).toBe(true);
  });

  it("历史导航回填时跳过更新，防止 slash 面板以 CRITICAL 优先级吞掉方向键", () => {
    expect(shouldSlashPanelProcessUpdate(new Set([HISTORY_NAVIGATION_UPDATE_TAG]))).toBe(false);
  });

  it("历史导航标记与其他标记共存时同样跳过", () => {
    expect(
      shouldSlashPanelProcessUpdate(new Set([HISTORY_NAVIGATION_UPDATE_TAG, PROGRAMMATIC_UPDATE_TAG])),
    ).toBe(false);
  });
});
