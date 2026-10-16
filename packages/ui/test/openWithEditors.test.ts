import { describe, expect, it } from "vitest";
import type { EditorInfo } from "@zcode/shared";
import { isFileManagerOpenTarget, sortInstalledEditorsForOpenWith } from "@/lib/openWithEditors.js";

function makeEditor(id: string): EditorInfo {
  return {
    id,
    name: id,
    iconDataUrl: `data:image/png;base64,${id}`,
  };
}

describe("open-with editor ordering", () => {
  it("通用模式仅保留各平台文件管理器", () => {
    const editors = [
      "vscode",
      "finder",
      "terminal",
      "qspace",
      "qspace-pro",
      "explorer",
      "cursor",
    ].map(makeEditor);
    expect(editors.filter(isFileManagerOpenTarget).map((editor) => editor.id)).toEqual([
      "finder",
      "qspace",
      "qspace-pro",
      "explorer",
    ]);
    expect(editors).toHaveLength(7);
  });
  it("pins file managers before regular editors in a stable shared order", () => {
    const sortedEditors = sortInstalledEditorsForOpenWith([
      makeEditor("cursor"),
      makeEditor("qspace-pro"),
      makeEditor("vscode"),
      makeEditor("explorer"),
      makeEditor("qspace"),
      makeEditor("finder"),
    ]);

    expect(sortedEditors.map((editor) => editor.id)).toEqual([
      "finder",
      "qspace",
      "qspace-pro",
      "explorer",
      "cursor",
      "vscode",
    ]);
  });
});
