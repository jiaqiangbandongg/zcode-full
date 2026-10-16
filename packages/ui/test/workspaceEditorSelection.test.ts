import { describe, expect, it } from "vitest";
import type { EditorInfo } from "@zcode/shared";
import {
  resolveWorkspaceFileManagerEditor,
  resolveWorkspaceEditorSelection,
  shouldPersistWorkspaceEditorSelection,
} from "../src/lib/workspaceEditorSelection.js";

const makeEditor = (id: string, name = id): EditorInfo => ({
  id,
  name,
  iconDataUrl: `data:image/png;base64,${id}`,
});

describe("workspaceEditorSelection", () => {
  it("SSH 工作区 fallback 到 VS Code 时不应持久化覆盖用户本地编辑器偏好", () => {
    const selection = resolveWorkspaceEditorSelection({
      installedEditors: [makeEditor("cursor"), makeEditor("vscode", "VS Code")],
      selectedEditorId: "cursor",
      remoteTarget: {
        kind: "ssh",
        host: "dev.internal",
        username: "root",
      },
    });

    expect(selection.availableEditors.map((editor) => editor.id)).toEqual(["vscode"]);
    expect(selection.selectedEditor?.id).toBe("vscode");
    expect(selection.selectionKind).toBe("fallback");
    expect(shouldPersistWorkspaceEditorSelection(selection.selectionKind)).toBe(false);
    const localSelection = resolveWorkspaceEditorSelection({
      installedEditors: [makeEditor("cursor"), makeEditor("vscode", "VS Code")],
      selectedEditorId: "cursor",
    });
    expect(localSelection.selectedEditor?.id).toBe("cursor");
  });

  it("WSL 工作区应只展示 Remote-WSL 可用编辑器并优先 fallback 到 VS Code", () => {
    const selection = resolveWorkspaceEditorSelection({
      installedEditors: [
        makeEditor("explorer", "资源管理器"),
        makeEditor("cursor", "Cursor"),
        makeEditor("vscode", "VS Code"),
      ],
      selectedEditorId: "cursor",
      remoteTarget: {
        kind: "wsl",
        distro: "Ubuntu",
      },
    });

    expect(selection.availableEditors.map((editor) => editor.id)).toEqual([
      "vscode",
      "explorer",
    ]);
    expect(selection.selectedEditor?.id).toBe("vscode");
    expect(selection.selectionKind).toBe("fallback");
    expect(shouldPersistWorkspaceEditorSelection(selection.selectionKind)).toBe(false);
  });

  it("不支持本机协议映射的 Docker 工作区不应展示本机编辑器", () => {
    const selection = resolveWorkspaceEditorSelection({
      installedEditors: [makeEditor("cursor"), makeEditor("vscode")],
      selectedEditorId: "vscode",
      remoteTarget: {
        kind: "docker",
        container: "dev-container",
      },
    });

    expect(selection.availableEditors).toEqual([]);
    expect(selection.selectedEditor).toBeNull();
    expect(selection.selectionKind).toBe("empty");
  });

  it("只有 WSL 可以复用 Explorer 作为远程文件管理器入口", () => {
    const editors = [
      makeEditor("vscode"),
      makeEditor("explorer", "资源管理器"),
    ];

    expect(
      resolveWorkspaceFileManagerEditor(editors, {
        kind: "wsl",
        distro: "Ubuntu",
      })?.id,
    ).toBe("explorer");
    expect(
      resolveWorkspaceFileManagerEditor(editors, {
        kind: "ssh",
        host: "dev.internal",
        username: "root",
      }),
    ).toBeNull();
    expect(
      resolveWorkspaceFileManagerEditor(editors, {
        kind: "docker",
        container: "dev-container",
      }),
    ).toBeNull();
  });
});
