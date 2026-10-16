import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

// Windows 工作区经 git autocrlf 是 CRLF，断言按 LF 编写；读取后归一化行尾，Linux 上是无操作。
const read = async (file: string) =>
  (await readFile(new URL(`../src/${file}.tsx`, import.meta.url), "utf8")).replaceAll("\r\n", "\n");
const dialogTags = (source: string) =>
  source.match(/<DialogContent\b[\s\S]*?(?=\n\s*>|>\n)/g) ?? [];

describe("dialog shell radius", () => {
  for (const file of ["components/ui/dialog", "components/ui/alert-dialog"]) {
    it(`${file} defaults to 2xl`, async () => {
      const source = await read(file);
      expect(source).toMatch(/gap-[45] rounded-2xl border/);
    });
  }
  for (const file of [
    "ChatMediaAttachmentPreviewDialog",
    "feedback/FeedbackScreenshotPicker",
    "ToolCallBlocks/renderers/CuaScreenshotSection",
  ]) {
    it(`${file} explicitly preserves xl`, async () => {
      const tags = dialogTags(await read(file));
      expect(tags).toHaveLength(1);
      expect(tags[0]).toContain("rounded-xl");
    });
  }
  for (const file of [
    "GitActionMenu",
    "settings/AutomationEditView",
    // 原生购买面板已下线（购买走 webview 弹窗），不再纳入 dialog 圆角契约。
    "quickpick/TaskFindDialog",
    "components/ui/command",
    "components/cloud-content-dialog/CloudContentDialog",
    "v4/ConversationComposer",
  ]) {
    it(`${file} does not override the standard shell with xl or 3xl`, async () => {
      const tags = dialogTags(await read(file));
      expect(tags.length).toBeGreaterThan(0);
      for (const tag of tags) expect(tag).not.toMatch(/\brounded-(?:xl|3xl)\b/);
    });
  }
});

it("chat-anchored find dialog uses the same 2xl shell", async () => {
  const source = await read("quickpick/TaskFindDialog");
  expect(source).toMatch(/role="dialog"[\s\S]*?className="[^"\n]*rounded-2xl/);
});
