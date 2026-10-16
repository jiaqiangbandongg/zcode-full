import { describe, expect, it } from "vitest";
import { resolveComposerAutoFocus } from "@/v4/composer/composerAutoFocus.js";

describe("resolveComposerAutoFocus", () => {
  const base = {
    autoFocusEnabled: true,
    disabled: false,
    isMobileViewport: false,
  };

  it("focuses immediately when enabled, editable and desktop", () => {
    expect(resolveComposerAutoFocus(base)).toBe("focus-now");
  });

  it("skips when the pane is not focused (autoFocusEnabled=false)", () => {
    // 竖切后台 pane：新建任务/切会话不应抢走焦点。
    expect(
      resolveComposerAutoFocus({ ...base, autoFocusEnabled: false }),
    ).toBe("skip");
  });

  it("skips on mobile viewport even when enabled and editable", () => {
    // 自动聚焦会弹出软键盘，移动端不自动聚焦。
    expect(
      resolveComposerAutoFocus({ ...base, isMobileViewport: true }),
    ).toBe("skip");
  });

  it("defers while the composer is disabled (session connecting)", () => {
    // 切到连接中会话时 disabled，先暂存意图，待可编辑再兑现。
    expect(resolveComposerAutoFocus({ ...base, disabled: true })).toBe(
      "defer",
    );
  });

  it("skip takes precedence over defer (unfocused + disabled → skip)", () => {
    expect(
      resolveComposerAutoFocus({
        autoFocusEnabled: false,
        disabled: true,
        isMobileViewport: false,
      }),
    ).toBe("skip");
  });

  it("mobile skip takes precedence over defer (mobile + disabled → skip)", () => {
    expect(
      resolveComposerAutoFocus({
        autoFocusEnabled: true,
        disabled: true,
        isMobileViewport: true,
      }),
    ).toBe("skip");
  });
});
