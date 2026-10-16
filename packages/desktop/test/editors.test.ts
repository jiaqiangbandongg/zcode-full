import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getFileIcon: vi.fn(),
  },
  nativeImage: {
    createFromBuffer: vi.fn(),
  },
}));

vi.mock("../src/main/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function setProcessPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: platform });
}

afterEach(() => {
  if (originalPlatformDescriptor) {
    Object.defineProperty(process, "platform", originalPlatformDescriptor);
  }
  vi.doUnmock("node:child_process");
  vi.doUnmock("node:fs");
  vi.restoreAllMocks();
  vi.resetModules();
});

async function importEditorsWithWindowsCommandMocks(
  existingPaths: string[],
  whereOutput: string,
  whereError?: Error,
) {
  setProcessPlatform("win32");
  const existingPathSet = new Set(existingPaths);

  vi.doMock("node:fs", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    return {
      ...actual,
      existsSync: vi.fn((path: string) => existingPathSet.has(path)),
    };
  });

  vi.doMock("node:child_process", async () => {
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    return {
      ...actual,
      execFileSync: vi.fn((file: string, args: string[]) => {
        if (file === "where.exe" && args[0] === "code") {
          if (whereError) {
            throw whereError;
          }
          return whereOutput;
        }
        return "";
      }),
    };
  });

  return import("../src/main/editors.js");
}

describe("editors", () => {
  it("macOS 应把 VS Code Insiders 识别为可用编辑器", async () => {
    setProcessPlatform("darwin");

    const { getEditorDefsForCurrentPlatform } = await import("../src/main/editors.js");

    expect(getEditorDefsForCurrentPlatform()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "vscode-insiders",
          name: "VS Code Insiders",
          appPath: "/Applications/Visual Studio Code - Insiders.app",
          command: "code-insiders",
        }),
      ]),
    );
  });

  it("macOS 应把 QSpace 和 QSpace Pro 识别为可用的第三方文件管理器", async () => {
    setProcessPlatform("darwin");

    const { getEditorDefsForCurrentPlatform } = await import("../src/main/editors.js");

    expect(getEditorDefsForCurrentPlatform()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "qspace",
          name: "QSpace",
          appPath: "/Applications/QSpace.app",
          command: null,
        }),
        expect.objectContaining({
          id: "qspace-pro",
          name: "QSpace Pro",
          appPath: "/Applications/QSpace Pro.app",
          command: null,
        }),
      ]),
    );
  });

  it("Windows 应把常见 IDE 纳入 workspace 顶部打开菜单候选", async () => {
    setProcessPlatform("win32");

    const { getEditorDefsForCurrentPlatform } = await import("../src/main/editors.js");
    const editorIds = getEditorDefsForCurrentPlatform().map((editor) => editor.id);

    expect(editorIds).toEqual(
      expect.arrayContaining(["explorer", "vscode", "trae", "idea", "pycharm"]),
    );
  });

  it("Windows requires PATH shims to resolve to a real app exe before showing gui editors", async () => {
    const shimPath = "D:\\Microsoft VS Code\\bin\\code";
    const { resolveEditorDefAppPath } = await importEditorsWithWindowsCommandMocks(
      [shimPath],
      `${shimPath}\r\n`,
    );

    expect(
      resolveEditorDefAppPath({
        id: "vscode",
        name: "VS Code",
        appPath: "C:\\missing\\Code.exe",
        command: "code",
        windowsCommandAppNames: ["Code.exe"],
      }),
    ).toBeNull();
  });

  it("Windows derives the real app exe from PATH shims for display and opening", async () => {
    const shimPath = "D:\\Microsoft VS Code\\bin\\code";
    const appPath = "D:\\Microsoft VS Code\\Code.exe";
    const { resolveEditorDefAppPath } = await importEditorsWithWindowsCommandMocks(
      [shimPath, appPath],
      `${shimPath}\r\n`,
    );

    expect(
      resolveEditorDefAppPath({
        id: "vscode",
        name: "VS Code",
        appPath: "C:\\missing\\Code.exe",
        command: "code",
        windowsCommandAppNames: ["Code.exe"],
      }),
    ).toBe(appPath);
  });

  it("Windows handles missing where.exe without throwing while detecting gui editors", async () => {
    const { resolveEditorDefAppPath } = await importEditorsWithWindowsCommandMocks(
      [],
      "",
      Object.assign(new Error("spawn where.exe ENOENT"), { code: "ENOENT" }),
    );

    expect(() =>
      resolveEditorDefAppPath({
        id: "vscode",
        name: "VS Code",
        appPath: "C:\\missing\\Code.exe",
        command: "code",
        windowsCommandAppNames: ["Code.exe"],
      }),
    ).not.toThrow();
  });
});
