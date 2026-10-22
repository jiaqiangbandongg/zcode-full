import { afterEach, describe, expect, it, vi } from "vitest";

const { accessMock, statMock, readdirMock, execFileMock } = vi.hoisted(() => ({
  accessMock: vi.fn(),
  statMock: vi.fn(),
  readdirMock: vi.fn(),
  execFileMock: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({ access: accessMock, stat: statMock, readdir: readdirMock }));
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

import {
  getFileApplicationDefs,
  matchesFileApplication,
  resolveFileApplicationPath,
} from "../src/main/fileApplications.js";

afterEach(() => vi.resetAllMocks());

describe("file applications", () => {
  it.each([
    ["pdf", ["preview", "adobe-acrobat", "adobe-reader", "pdf-expert", "wps"]],
    ["docx", ["word", "pages", "wps", "libreoffice-writer"]],
    ["pptx", ["powerpoint", "keynote", "wps", "libreoffice-impress"]],
    ["xlsx", ["excel", "numbers", "wps", "libreoffice-calc"]],
    ["mp3", ["music", "quicktime", "iina", "vlc"]],
    ["mp4", ["quicktime", "iina", "vlc"]],
  ])("macOS %s 只返回匹配的候选", (extension, expected) => {
    const ids = getFileApplicationDefs("darwin")
      .filter((def) => matchesFileApplication(def, `/work/输出 文件.${extension.toUpperCase()}`))
      .map((def) => def.id);
    expect(ids).toEqual(expected);
  });
  it("无路径和未知类型不添加应用", () => {
    for (const path of [undefined, "/work/a.ts", "/work/pdf", "/work/file.pdf/folder"]) {
      expect(
        getFileApplicationDefs("darwin").filter((def) => matchesFileApplication(def, path)),
      ).toEqual([]);
    }
  });
  it("Windows 和 Linux 格式映射独立，文件夹菜单不受影响", () => {
    expect(
      getFileApplicationDefs("win32")
        .filter((def) => matchesFileApplication(def, "C:\\输出\\a.pdf"))
        .map((def) => def.id),
    ).toEqual(["adobe-acrobat", "adobe-reader", "foxit", "wps", "edge"]);
    expect(
      getFileApplicationDefs("linux")
        .filter((def) => matchesFileApplication(def, "/tmp/a.mp4"))
        .map((def) => def.id),
    ).toEqual(["vlc", "mpv"]);
  });
  it("未安装应用不返回路径", async () => {
    accessMock.mockRejectedValue(new Error("ENOENT"));
    const def = getFileApplicationDefs("darwin").find((def) => def.id === "pages")!;
    expect(await resolveFileApplicationPath(def, "darwin")).toBeNull();
  });
  it("支持用户 Applications 下安装的应用", async () => {
    const def = getFileApplicationDefs("darwin").find((def) => def.id === "pages")!;
    accessMock.mockImplementation(async (path: string) => {
      if (!path.endsWith("/Applications/Pages.app") || path === "/Applications/Pages.app")
        throw new Error("ENOENT");
    });
    expect(await resolveFileApplicationPath(def, "darwin")).toMatch(/\/Applications\/Pages.app$/);
  });
  it("Linux 从 PATH 查找可执行文件", async () => {
    accessMock.mockImplementation(async (path: string) => {
      if (path !== "/usr/bin/vlc") throw new Error("ENOENT");
    });
    const def = getFileApplicationDefs("linux").find((def) => def.id === "vlc")!;
    expect(await resolveFileApplicationPath(def, "linux", "/missing:/usr/bin")).toBe(
      "/usr/bin/vlc",
    );
  });
  it("Windows 从 App Paths 找到非标准位置的 Word", async () => {
    accessMock.mockRejectedValue(new Error("ENOENT"));
    statMock.mockResolvedValue({ isFile: () => true });
    execFileMock.mockImplementation((_file, _args, _options, callback) =>
      callback(null, '    (Default)    REG_SZ    "D:\\Office Suite\\WINWORD.EXE"\r\n'),
    );
    const def = getFileApplicationDefs("win32").find((def) => def.id === "word")!;
    expect(await resolveFileApplicationPath(def, "win32")).toBe("D:\\Office Suite\\WINWORD.EXE");
  });
  it("Windows 支持 WPS 的版本化安装目录", async () => {
    const root = "C:\\Programs\\WPS Office";
    const executable = `${root}\\12.1\\office6\\ksolaunch.exe`;
    accessMock.mockImplementation(async (path) => {
      if (path !== executable) throw new Error("ENOENT");
    });
    execFileMock.mockImplementation((_file, _args, _options, callback) =>
      callback(new Error("not registered"), ""),
    );
    readdirMock.mockResolvedValue([{ name: "12.1", isDirectory: () => true }]);
    const def = getFileApplicationDefs("win32").find((def) => def.id === "wps")!;
    expect(await resolveFileApplicationPath({ ...def, windowsVersionRoots: [root] }, "win32")).toBe(
      executable,
    );
  });
});
