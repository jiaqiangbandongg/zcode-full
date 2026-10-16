import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { buildEditCodeViewerSource } from "../src/ToolCallBlocks/renderers/edit.js";
import {
  getEditKindLabelMessageId,
  renderFileChip,
} from "../src/ToolCallBlocks/renderers.js";

describe("buildEditCodeViewerSource", () => {
  it("uses the real file path instead of the display directory", () => {
    const source = buildEditCodeViewerSource({
      path: "/Users/dev/Projects/z-code/packages/ui/src/i18n/locales/zh-CN.ts",
      actionLabel: "Edited",
      operationKind: "update",
      fileName: "zh-CN.ts",
      filePath: "/Users/dev/Projects/z-code/packages/ui/src/i18n/locales/",
      fileIconSrc: "/material-icons/typescript.svg",
      changeStat: { added: 1, removed: 0 },
      patch:
        "--- a/zh-CN.ts\n" +
        "+++ b/zh-CN.ts\n" +
        "@@ -513,2 +513,3 @@\n" +
        '   "chat.changeSummary.diffUnavailable": "暂时无法预览这份 Diff。",\n' +
        '+  "chat.changeSummary.openInSelectedApp": "在所选 App 中打开",\n' +
        '   "chat.changeSummary.rewind": "撤销",',
    });

    expect(source).toMatchObject({
      type: "patch",
      title: "zh-CN.ts",
      path: "/Users/dev/Projects/z-code/packages/ui/src/i18n/locales/zh-CN.ts",
    });
  });
});

describe("getEditKindLabelMessageId", () => {
  it("uses edit labels for update operations", () => {
    expect(getEditKindLabelMessageId(["update"], [], true)).toBe("chat.toolCall.edit.editing");
    expect(getEditKindLabelMessageId(["update"], [], false)).toBe("chat.toolCall.kind.edit");
  });

  it("uses stable terminal kinds for writes and deletes", () => {
    expect(getEditKindLabelMessageId(["write"], [], false)).toBe("chat.toolCall.kind.write");
    expect(getEditKindLabelMessageId(["delete"], [], false)).toBe("chat.toolCall.kind.delete");
  });
});

describe("renderFileChip", () => {
  it.each([false, true])("uses the subtle filename color (clickable=%s)", (clickable) => {
    const html = renderToStaticMarkup(
      renderFileChip({
        summary: {
          path: "/workspace/src/App.tsx",
          actionLabel: "Edited",
          operationKind: "update",
          fileName: "App.tsx",
          filePath: "/workspace/src/",
          fileIconSrc: "/material-icons/typescript.svg",
        },
        clickable,
      }),
    );
    expect(html).toContain("text-foreground-subtle");
    expect(html).not.toMatch(/(?:class="[^"]* )text-foreground(?: |")/u);
  });
});
