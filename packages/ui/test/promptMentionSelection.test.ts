// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  $createParagraphNode,
  $createTextNode,
  $createLineBreakNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  createEditor,
} from "lexical";
import { $createPromptMentionNode, PromptMentionNode } from "@/mentions/nodes/PromptMentionNode.js";
import { $getPromptMarkdown, $getPromptSelectionMarkdown } from "@/mentions/promptSerialization.js";

const canonical = "[demo.ts](src/demo.ts)";
function setup(run: () => void) {
  const editor = createEditor({
    nodes: [PromptMentionNode],
    onError: (e) => {
      throw e;
    },
  });
  editor.update(run, { discrete: true });
}
function mention() {
  return $createPromptMentionNode({
    id: "file:test",
    category: "files",
    label: "@demo.ts",
    value: "src/demo.ts",
    markdown: canonical,
    data: { path: "src/demo.ts" },
  });
}

describe("mention selection contract", () => {
  it("uses visible text for offsets and canonical only for prompt serialization", () =>
    setup(() => {
      const node = mention();
      $getRoot().append($createParagraphNode().append(node));
      expect(node.getTextContent()).toBe("demo.ts");
      expect(node.getTextContentSize()).toBe(7);
      expect($getPromptMarkdown()).toBe(canonical);
      const dom = node.createDOM({ namespace: "test", theme: {} });
      expect(dom.textContent).toBe(node.getTextContent());
      expect(dom.firstChild?.nodeType).toBe(Node.TEXT_NODE);
      expect(dom.querySelector("img,svg")).toBeNull();
      expect(dom.style.getPropertyValue("--mention-image")).toContain(
        new URL("/material-icons/", document.baseURI).href,
      );
    }));

  it("restores legacy JSON while preserving the canonical identity", () => {
    const editor = createEditor({
      nodes: [PromptMentionNode],
      onError: (e) => {
        throw e;
      },
    });
    setup(() => {
      const token = mention().exportJSON();
      const legacy = { ...token, text: "[@demo.ts](src/demo.ts)" };
      const state = editor.parseEditorState(
        JSON.stringify({
          root: {
            type: "root",
            version: 1,
            format: "",
            indent: 0,
            direction: null,
            children: [
              {
                type: "paragraph",
                version: 1,
                format: "",
                indent: 0,
                direction: null,
                children: [legacy],
              },
            ],
          },
        }),
      );
      state.read(() => {
        expect($getRoot().getTextContent()).toBe("demo.ts");
        expect($getPromptMarkdown()).toBe(canonical);
        expect($getRoot().getFirstDescendant()?.exportJSON()).toMatchObject({
          mentionId: legacy.mentionId,
          markdown: canonical,
          version: 1,
        });
      });
    });
  });

  for (const category of [
    "files",
    "skills",
    "commands",
    "subagents",
    "sessions",
    "whiteboards",
    "plugins",
  ] as const) {
    it(`preserves ${category} canonical independently of its label`, () =>
      setup(() => {
        const node = $createPromptMentionNode({
          id: category,
          category,
          label: "演示🙂",
          value: "演示🙂",
          markdown: "CANONICAL_IDENTITY",
        });
        $getRoot().append($createParagraphNode().append(node));
        expect(node.getTextContent()).toBe("演示🙂");
        expect($getPromptMarkdown()).toBe("CANONICAL_IDENTITY");
        const selection = node.select(0, node.getTextContentSize());
        expect($getPromptSelectionMarkdown(selection)).toBe("CANONICAL_IDENTITY");
      }));
  }

  it("preserves paragraphs, blank paragraphs, linebreaks and unicode", () =>
    setup(() => {
      $getRoot().append(
        $createParagraphNode().append(
          $createTextNode("你好🙂 "),
          mention(),
          $createLineBreakNode(),
          $createTextNode("尾部 "),
        ),
        $createParagraphNode(),
        $createParagraphNode().append($createTextNode("终")),
      );
      expect($getPromptMarkdown()).toBe(`你好🙂 ${canonical}\n尾部 \n\n\n\n终`);
    }));

  for (const backward of [false, true]) {
    it(`serializes partial text around an atomic mention (${backward ? "backward" : "forward"})`, () =>
      setup(() => {
        const left = $createTextNode("hello "),
          node = mention(),
          right = $createTextNode(" world");
        $getRoot().append($createParagraphNode().append(left, node, right));
        const selection = left.select(2, 2);
        selection.focus.set(right.getKey(), 3, "text");
        if (backward) {
          selection.anchor.set(right.getKey(), 3, "text");
          selection.focus.set(left.getKey(), 2, "text");
        }
        expect($getPromptSelectionMarkdown(selection)).toBe(`llo ${canonical} wo`);
      }));
  }

  it("does not copy a mention merely touching the selection endpoint", () =>
    setup(() => {
      const left = $createTextNode("hello "),
        node = mention();
      $getRoot().append($createParagraphNode().append(left, node));
      const selection = left.select(0, 0);
      selection.focus.set(node.getKey(), 0, "text");
      expect($getPromptSelectionMarkdown(selection)).toBe("hello ");
      node.select(2, 2);
      const collapsed = $getSelection();
      expect($isRangeSelection(collapsed) && $getPromptSelectionMarkdown(collapsed)).toBe("");
      node.select(1, 3);
      const partial = $getSelection();
      expect($isRangeSelection(partial) && $getPromptSelectionMarkdown(partial)).toBe(canonical);
    }));
});
