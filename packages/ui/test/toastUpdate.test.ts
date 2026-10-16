// @vitest-environment jsdom

import { cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toast, updateToast } from "@/components/ui/toast.js";

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("toast updates", () => {
  it("updates an existing toast in place instead of stacking a second item", async () => {
    let id = toast("导入状态初始化", { durationMs: 0, dedupeKey: "share-import" });
    // Toast 容器可能还没有完成首帧挂载，更新也必须保留并合并到即将挂载的同一个 item。
    updateToast(id, { message: "正在下载分享文件：0/1", variant: "info" });
    await waitFor(() => {
      expect(document.querySelector("#zcode-toast-host")?.textContent).toContain(
        "正在下载分享文件：0/1",
      );
    });

    // 同一操作的替代提示仍须去重，同时保留紧接着到达的进度更新。
    id = toast("正在完成导入", { durationMs: 0, dedupeKey: "share-import" });
    updateToast(id, { message: "已从分享导入：示例会话", durationMs: 10 });
    await waitFor(() => {
      const hostText = document.querySelector("#zcode-toast-host")?.textContent ?? "";
      expect(hostText).toContain("已从分享导入：示例会话");
      expect(hostText).not.toContain("正在下载分享文件：0/1");
      expect(document.querySelectorAll("#zcode-toast-host .rounded-2xl")).toHaveLength(1);
    });
    await waitFor(
      () => expect(document.querySelectorAll("#zcode-toast-host .rounded-2xl")).toHaveLength(0),
      { timeout: 1000 },
    );
  });
});
