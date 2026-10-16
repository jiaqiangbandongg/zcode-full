import {
  buildSelectionSideChatKey,
  registerSelectionSideChatOpener,
} from "@/lib/selectionSideChatRuntime.js";
// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { MarkdownPreviewContent } from "@/previewPaneMarkdownContent.js";
import {
  appendConversationSelectionReference,
  buildPromptWithConversationSelections,
  getConversationSelectionReferenceScope,
  setConversationSelectionReferenceScope,
  type ConversationSelectionReference,
} from "@/lib/conversationSelectionReference.js";

vi.mock("@/components/ai-elements/message.js", () => ({
  MessageResponse: ({ children }: { children: string }) => createElement("p", null, children),
}));
const target = { sessionId: null, workspaceKey: "ssh:first:/workspace" };
const reference: ConversationSelectionReference = {
  id: "md-1",
  contentType: "markdown",
  sourceKey: "/workspace/a.md",
  sourceTitle: "a.md",
  path: "/workspace/a.md",
  text: "Selected paragraph",
};
function preview(content = "Selected paragraph", sessionId: string | null = null) {
  return createElement(
    ZCodeIntlProvider,
    { initialLocale: "en-US" },
    createElement(MarkdownPreviewContent, {
      content,
      sourceKey: "/workspace/a.md",
      sourceTitle: "a.md",
      sourcePath: "/workspace/a.md",
      selectionTarget: { ...target, sessionId },
    }),
  );
}
async function selectText(event = "mouseup") {
  const text = screen.getByText("Selected paragraph").firstChild!;
  const range = document.createRange();
  range.selectNodeContents(text);
  range.getBoundingClientRect = () =>
    ({ left: 100, top: 120, bottom: 140, width: 100, height: 20 }) as DOMRect;
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  await act(async () => {
    if (event === "selectionchange") document.dispatchEvent(new Event(event));
    else text.parentElement!.dispatchEvent(new MouseEvent(event, { bubbles: true }));
  });
  return screen.findByRole("button", { name: "Add to chat" });
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.getSelection()?.removeAllRanges();
  setConversationSelectionReferenceScope(null, target.workspaceKey, []);
});
describe("Markdown preview selections", () => {
  it("区分 Markdown 来源，去重并发送路径与选中文字", () => {
    expect(
      appendConversationSelectionReference([reference], { ...reference, id: "md-2" }),
    ).toMatchObject({ duplicate: true });
    expect(
      appendConversationSelectionReference([reference], {
        ...reference,
        sourceKey: "/workspace/b.md",
      }),
    ).toMatchObject({ duplicate: false });
    expect(buildPromptWithConversationSelections("Explain", [reference])).toContain(
      JSON.stringify([{ path: "/workspace/a.md", text: reference.text }]),
    );
    expect(buildPromptWithConversationSelections("Explain", [reference])).not.toContain(
      "sourceKey",
    );
    expect(
      appendConversationSelectionReference([reference], { ...reference, text: "x".repeat(8001) }),
    ).toEqual({ ok: false, reason: "single" });
  });
  it("触控选区添加到明确的远程草稿 scope，不串同路径 workspace", async () => {
    render(preview());
    fireEvent.click(await selectText("selectionchange"));
    expect(getConversationSelectionReferenceScope(null, target.workspaceKey)).toMatchObject([
      { text: reference.text, contentType: "markdown", path: "/workspace/a.md" },
    ]);
    expect(getConversationSelectionReferenceScope(null, "ssh:second:/workspace")).toEqual([]);
    expect(getConversationSelectionReferenceScope("other-task", target.workspaceKey)).toEqual([]);
  });
  it("Escape、滚动、内容与目标切换清除旧浮层", async () => {
    const view = render(preview());
    await selectText();
    fireEvent.keyUp(document, { key: "Escape" });
    expect(screen.queryByRole("button", { name: "Add to chat" })).toBeNull();
    await selectText();
    fireEvent.scroll(view.container.querySelector("[data-markdown-preview]")!);
    expect(screen.queryByRole("button", { name: "Add to chat" })).toBeNull();
    await selectText();
    view.rerender(preview("Changed"));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Add to chat" })).toBeNull());
    view.rerender(preview());
    await selectText();
    view.rerender(preview("Selected paragraph", "task-b"));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Add to chat" })).toBeNull());
  });
  it("窄屏浮层留在视口内，空白和跨预览选区不提供入口", async () => {
    vi.stubGlobal("innerWidth", 180);
    const view = render(preview());
    await selectText();
    const popup = document.querySelector<HTMLElement>("[data-conversation-selection-tooltip]")!;
    expect(Number.parseFloat(popup.style.left)).toBeGreaterThanOrEqual(12);
    expect(Number.parseFloat(popup.style.maxWidth)).toBe(156);
    expect(popup.style.width).toBe("max-content");
    const outside = document.createElement("p");
    outside.textContent = "Outside";
    document.body.append(outside);
    const range = document.createRange();
    range.setStart(screen.getByText("Selected paragraph").firstChild!, 0);
    range.setEnd(outside.firstChild!, 3);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    fireEvent.mouseUp(view.container.querySelector("[data-markdown-preview]")!);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Add to chat" })).toBeNull());
    outside.remove();
    view.rerender(preview("   "));
    const blank = view.container.querySelector("p")!.firstChild!;
    range.selectNodeContents(blank);
    selection.removeAllRanges();
    selection.addRange(range);
    fireEvent.mouseUp(blank.parentElement!);
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(screen.queryByRole("button", { name: "Add to chat" })).toBeNull();
  });
  it("辅助动作传递 Markdown 引用，主草稿引用不变；未就绪时禁用", async () => {
    const view = render(preview());
    await selectText();
    expect(
      (screen.getByRole("button", { name: "Add in side chat" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    const open = vi.fn(async () => {});
    const unregister = registerSelectionSideChatOpener(
      buildSelectionSideChatKey(target.workspaceKey, "parent"),
      open,
      true,
    );
    try {
      view.rerender(preview("Selected paragraph", "parent"));
      await selectText();
      fireEvent.click(screen.getByRole("button", { name: "Add in side chat" }));
      expect(open).toHaveBeenCalledWith(
        expect.objectContaining({ contentType: "markdown", text: reference.text }),
      );
      expect(getConversationSelectionReferenceScope("parent", target.workspaceKey)).toEqual([]);
    } finally {
      unregister();
    }
  });
});
