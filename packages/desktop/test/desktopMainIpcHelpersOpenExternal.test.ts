import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  shellOpenPath: vi.fn(),
}));

vi.mock("electron", () => ({
  shell: {
    openPath: h.shellOpenPath,
  },
}));

describe("openPathInDefaultApp", () => {
  beforeEach(() => {
    h.shellOpenPath.mockReset();
  });

  it("uses shell.openPath for a local HTML file and reports success", async () => {
    h.shellOpenPath.mockResolvedValue("");
    const { openPathInDefaultApp } = await import("../src/main/desktopMainIpcHelpers.js");
    const logger = { info: vi.fn(), warn: vi.fn() };

    const result = await openPathInDefaultApp("E:\\项目\\preview page.html", logger);

    expect(h.shellOpenPath).toHaveBeenCalledWith("E:\\项目\\preview page.html");
    expect(result).toEqual({ success: true });
    expect(logger.info).toHaveBeenCalledWith("[open-external] 本地文件打开成功", {
      path: "E:\\项目\\preview page.html",
    });
  });

  it("returns and logs the shell error instead of failing silently", async () => {
    h.shellOpenPath.mockResolvedValue("No application is associated with the specified file");
    const { openPathInDefaultApp } = await import("../src/main/desktopMainIpcHelpers.js");
    const logger = { info: vi.fn(), warn: vi.fn() };

    const result = await openPathInDefaultApp("E:\\preview.html", logger);

    expect(result).toEqual({
      success: false,
      error: "No application is associated with the specified file",
    });
    expect(logger.warn).toHaveBeenCalledWith("[open-external] 本地文件打开失败", {
      path: "E:\\preview.html",
      error: "No application is associated with the specified file",
    });
  });
});
