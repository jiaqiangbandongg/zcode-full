import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readOpenSplitButtonSource() {
  return readFileSync(
    resolve(process.cwd(), "packages/ui/src/OpenSplitButton.tsx"),
    "utf8",
  );
}

function readAssistantPreviewCardsSource() {
  return readFileSync(
    resolve(process.cwd(), "packages/ui/src/AssistantPreviewCards.tsx"),
    "utf8",
  );
}

describe("OpenSplitButton open-with ordering", () => {
  it("renders file preview open-with items through the shared sorted editor list", () => {
    const source = readOpenSplitButtonSource();

    expect(source).toContain("resolveWorkspaceEditorSelection({");
    expect(source).toContain("remoteTarget: openInEditorRemoteTarget");
    expect(source).toContain("sortedEditors.map((editor)");
    expect(source).not.toContain("editors.map((editor)");
  });

  it("本地 HTML 外部打开保留文件路径并走平台文件打开接口", () => {
    const source = readOpenSplitButtonSource();
    const cardSource = readAssistantPreviewCardsSource();

    // localPath 直开只允许 file:// 形式的 html 引用卡；localhost 活服务卡必须继续走 URL。
    expect(cardSource).toContain('card.url.startsWith("file:") ? card.filePath : undefined');
    expect(source).toContain("localPath?: string");
    expect(source).toContain("platform.openExternalFile");
    expect(source).toContain("toast(");
  });
});
