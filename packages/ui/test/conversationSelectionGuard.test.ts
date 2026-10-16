import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  guardConversationSelectionCandidate,
  hasExcludedConversationSelectionEndpoint,
} from "../src/lib/conversationSelectionGuard.js";

const VALID = {
  enabled: true,
  sameRow: true,
  insideTimeline: true,
  excluded: false,
  sameSelectableRegion: true,
  supportedContent: true,
  text: "selected text",
  hasLayout: true,
} as const;

describe("conversation selection guard", () => {
  it("接受单 row 正文选区并识别单条超限", () => {
    expect(guardConversationSelectionCandidate(VALID)).toBe("eligible");
    expect(guardConversationSelectionCandidate({ ...VALID, text: "x".repeat(8_001) })).toBe(
      "single-limit",
    );
  });

  it.each([
    { sameRow: false },
    { insideTimeline: false },
    { excluded: true },
    { sameSelectableRegion: false },
    { supportedContent: false },
    { enabled: false },
    { text: "" },
    { hasLayout: false },
  ])("拒绝跨行、控件、非正文、关闭门禁和空选区 %#", (patch) => {
    expect(guardConversationSelectionCandidate({ ...VALID, ...patch })).toBe("ineligible");
  });

  it("只按选区端点拒绝控件，避免表格工具栏夹在 Range 中时误伤正文", () => {
    const contentEndpoint = { closest: () => null } as unknown as Element;
    const controlEndpoint = { closest: () => ({}) as Element } as unknown as Element;

    expect(hasExcludedConversationSelectionEndpoint(contentEndpoint, contentEndpoint)).toBe(false);
    expect(hasExcludedConversationSelectionEndpoint(controlEndpoint, contentEndpoint)).toBe(true);
    expect(hasExcludedConversationSelectionEndpoint(contentEndpoint, controlEndpoint)).toBe(true);
  });

  it("使用紧凑 tooltip 密度并统一为辅助对话术语", () => {
    const source = readFileSync(
      resolve(process.cwd(), "packages/ui/src/v4/SelectionActionMenu.tsx"),
      "utf8",
    );
    const zh = readFileSync(
      resolve(process.cwd(), "packages/ui/src/i18n/locales/zh-CN.ts"),
      "utf8",
    );

    expect(source).toContain("rounded-lg");
    expect(source).toContain("text-ui-sm");
    expect(source).toContain("shadow-md");
    expect(source).toContain("px-2.5 py-1.5");
    expect(source).not.toContain("range.cloneContents().querySelector");
    expect(source).not.toContain("rounded-xl");
    expect(zh).toContain('"sidePane.selectionChat": "辅助对话"');
    expect(zh).toContain('"chat.selections.askInSideChat": "在辅助对话中提问"');
  });
});
