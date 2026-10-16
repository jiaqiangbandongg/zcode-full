import { describe, expect, it } from "vitest";
import { shouldIgnoreRemoteConnectionHistoryPopoverInteractOutside } from "@/remote-connection/remoteConnectionHistoryPopover.js";

describe("shouldIgnoreRemoteConnectionHistoryPopoverInteractOutside", () => {
  it("输入框容器本身触发 outside interaction 时保持建议列表打开", () => {
    expect(
      shouldIgnoreRemoteConnectionHistoryPopoverInteractOutside({
        isTargetInsideContainer: true,
      }),
    ).toBe(true);
  });

  it("真正发生在容器外部的交互允许关闭建议列表", () => {
    expect(
      shouldIgnoreRemoteConnectionHistoryPopoverInteractOutside({
        isTargetInsideContainer: false,
      }),
    ).toBe(false);
  });
});
