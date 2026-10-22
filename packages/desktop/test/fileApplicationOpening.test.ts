import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { accessMock, execFileMock, spawnMock, statMock } = vi.hoisted(() => ({
  accessMock: vi.fn(),
  execFileMock: vi.fn(),
  spawnMock: vi.fn(),
  statMock: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({ access: accessMock, readdir: vi.fn(), stat: statMock }));
vi.mock("node:child_process", () => ({ execFile: execFileMock, spawn: spawnMock }));
vi.mock("electron", () => ({ shell: { openPath: vi.fn(), showItemInFolder: vi.fn() } }));
vi.mock("@zcode/server/remote/wsl-detect.js", () => ({ listWSLDistros: vi.fn() }));
vi.mock("../src/main/logger.js", () => ({ logger: { warn: vi.fn() } }));
vi.mock("../src/main/editors.js", async () => {
  const { getFileApplicationDefs } = await import("../src/main/fileApplications.js");
  return {
    getEditorDefsForCurrentPlatform: getFileApplicationDefs,
    resolveEditorDefAppPath: vi.fn(),
  };
});
import { openInEditor } from "../src/main/openInEditor.js";
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(() => {
  accessMock.mockResolvedValue(undefined);
  statMock.mockResolvedValue({ isFile: () => true });
  spawnMock.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
  execFileMock.mockImplementation(
    (_file: string, _args: string[], callback: (error: Error | null) => void) => callback(null),
  );
});
afterEach(() => {
  Object.defineProperty(process, "platform", platformDescriptor);
  vi.resetAllMocks();
});

describe("file application opening", () => {
  it.each([
    [
      "darwin",
      "preview",
      "/work/报告 文件.PDF",
      "open",
      ["-a", "/System/Applications/Preview.app", "/work/报告 文件.PDF"],
    ],
    [
      "linux",
      "libreoffice-impress",
      "/work/演示 文稿.pptx",
      "/usr/bin/libreoffice",
      ["--impress", "/work/演示 文稿.pptx"],
    ],
  ])("%s 参数数组保留文件路径", async (platform, id, path, command, args) => {
    Object.defineProperty(process, "platform", { value: platform });
    expect(await openInEditor(id, path, { pathKind: "file" })).toEqual({ success: true });
    if (platform === "darwin") {
      expect(execFileMock).toHaveBeenCalledExactlyOnceWith(command, args, expect.any(Function));
    } else {
      expect(spawnMock).toHaveBeenCalledExactlyOnceWith(command, args, {
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      });
      expect(execFileMock).not.toHaveBeenCalled();
      expect(spawnMock.mock.results[0]?.value.unref).toHaveBeenCalledOnce();
    }
  });
  it("Windows GUI 启动后立即脱离，保留带空格的绝对路径", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const path = "C:\\work\\报告 文件.docx";
    expect(await openInEditor("word", path, { pathKind: "file" })).toEqual({ success: true });
    expect(spawnMock).toHaveBeenCalledWith(expect.stringMatching(/WINWORD\.EXE$/iu), [path], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    expect(spawnMock.mock.results[0]?.value.unref).toHaveBeenCalledOnce();
    expect(execFileMock).not.toHaveBeenCalled();
  });
  it("拒绝远端路径、不匹配类型和目录", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    for (const [path, options] of [
      ["/work/a.docx", { pathKind: "file" }],
      ["/work/a.pdf", { pathKind: "directory" }],
      ["/work/a.pdf", { remoteTarget: { kind: "ssh", host: "example.com", user: "dev" } }],
    ] as const) {
      expect((await openInEditor("preview", path, options)).success).toBe(false);
    }
    expect(execFileMock).not.toHaveBeenCalled();
  });
  it("卸载后不尝试启动应用", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    accessMock.mockRejectedValue(new Error("ENOENT"));
    expect((await openInEditor("preview", "/work/a.pdf")).success).toBe(false);
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

it("不信任 renderer 的文件类型，也不接受相对路径或选项", async () => {
  Object.defineProperty(process, "platform", { value: "linux" });
  for (const path of ["--convert-to=x.docx", "report.docx"]) {
    expect((await openInEditor("libreoffice-writer", path, { pathKind: "file" })).success).toBe(
      false,
    );
  }
  statMock.mockResolvedValue({ isFile: () => false });
  expect(
    (await openInEditor("libreoffice-writer", "/work/directory.docx", { pathKind: "file" }))
      .success,
  ).toBe(false);
  statMock.mockRejectedValue(new Error("ENOENT"));
  expect((await openInEditor("libreoffice-writer", "/work/missing.docx")).success).toBe(false);
  expect(spawnMock).not.toHaveBeenCalled();
});
it("启动失败返回错误；spawn 成功不等待应用退出", async () => {
  Object.defineProperty(process, "platform", { value: "linux" });
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  spawnMock.mockImplementation(() => {
    queueMicrotask(() => child.emit("error", new Error("EACCES")));
    return child;
  });
  expect(await openInEditor("libreoffice-impress", "/work/slides.pptx")).toEqual({
    success: false,
    error: "EACCES",
  });
  expect(child.unref).not.toHaveBeenCalled();
});
