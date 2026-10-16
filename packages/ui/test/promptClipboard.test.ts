// @vitest-environment jsdom
import { registerPlainText } from "@lexical/plain-text";
import { describe, expect, it, vi } from "vitest";
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  createEditor,
  COPY_COMMAND,
  CUT_COMMAND,
} from "lexical";
import { $createPromptMentionNode, PromptMentionNode } from "@/mentions/nodes/PromptMentionNode.js";
import { registerPromptClipboard } from "@/mentions/PromptClipboardPlugin.js";
import { $getPromptMarkdown } from "@/mentions/promptSerialization.js";

const markdown = "[@Demo](plugin://demo@mkt)";
function setup() {
  const editor = createEditor({
    nodes: [PromptMentionNode],
    onError: (e) => {
      throw e;
    },
  });
  registerPlainText(editor);
  registerPromptClipboard(editor);
  editor.update(
    () => {
      const mention = $createPromptMentionNode({
        id: "plugin:demo",
        category: "plugins",
        label: "Demo",
        value: "demo@mkt",
        markdown,
      });
      $getRoot().append(
        $createParagraphNode().append(
          $createTextNode("before "),
          mention,
          $createTextNode(" after"),
        ),
      );
      mention.select(1, 3);
    },
    { discrete: true },
  );
  return editor;
}
function event(fail = false) {
  const result = new Event("copy", { cancelable: true });
  const setData = vi.fn(() => {
    if (fail) throw new Error("clipboard unavailable");
  });
  Object.defineProperty(result, "clipboardData", { value: { setData } });
  return { result: result as ClipboardEvent, setData };
}

describe("prompt clipboard", () => {
  for (const cut of [false, true]) {
    it(`${cut ? "cuts" : "copies"} a partial mention as one canonical token`, () => {
      const editor = setup(),
        { result, setData } = event();
      editor.update(
        () => {
          expect(editor.dispatchCommand(cut ? CUT_COMMAND : COPY_COMMAND, result)).toBe(true);
        },
        { discrete: true },
      );
      expect(setData).toHaveBeenCalledWith("text/plain", markdown);
      expect(result.defaultPrevented).toBe(true);
      expect(editor.getEditorState().read(() => $getPromptMarkdown())).toBe(
        cut ? "before  after" : `before ${markdown} after`,
      );
    });
  }
  it("does not delete the selection when clipboard writing fails", () => {
    const editor = setup(),
      { result } = event(true);
    editor.update(
      () => {
        expect(editor.dispatchCommand(CUT_COMMAND, result)).toBe(true);
      },
      { discrete: true },
    );
    expect(result.defaultPrevented).toBe(true);
    expect(editor.getEditorState().read(() => $getPromptMarkdown())).toBe(
      `before ${markdown} after`,
    );
  });
  it("unregisters both command handlers", () => {
    const editor = createEditor({ nodes: [PromptMentionNode] });
    const unregister = registerPromptClipboard(editor);
    unregister();
    expect(editor.dispatchCommand(COPY_COMMAND, event().result)).toBe(false);
    expect(editor.dispatchCommand(CUT_COMMAND, event().result)).toBe(false);
  });
});
