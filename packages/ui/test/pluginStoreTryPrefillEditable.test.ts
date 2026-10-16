// @vitest-environment jsdom

import { $getPromptMarkdown } from "@/mentions/promptSerialization.js";
import { describe, expect, it } from "vitest";
import {
  $getRoot,
  $createTextNode,
  $createParagraphNode,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  createEditor,
} from "lexical";
import {
  insertEditorMention,
  prependEditorMentionIfMissing,
  replaceEditorWithMention,
} from "@/LexicalChatInput.js";
import {
  $createPromptMentionNode,
  $isPromptMentionNode,
  PromptMentionNode,
} from "@/mentions/nodes/PromptMentionNode.js";

const TRY_NOW_MENTION = {
  id: "plugin:commit-commands@zcode-official",
  category: "plugins" as const,
  label: "commit-commands",
  value: "commit-commands@zcode-official",
  markdown: "[@commit-commands](plugin://commit-commands@zcode-official)",
  data: { pluginId: "commit-commands@zcode-official" },
};

const SECOND_PLUGIN_MENTION = {
  id: "plugin:pdf@zcode-plugins-official",
  category: "plugins" as const,
  label: "pdf",
  value: "pdf@zcode-plugins-official",
  markdown: "[@pdf](plugin://pdf@zcode-plugins-official)",
  data: { pluginId: "pdf@zcode-plugins-official" },
};

async function prefill(trailingText?: string) {
  const editor = createEditor({ nodes: [PromptMentionNode] });
  editor.setRootElement(document.createElement("div"));
  await new Promise<void>((resolve) => {
    editor.registerUpdateListener(() => resolve());
    replaceEditorWithMention(editor, TRY_NOW_MENTION, trailingText);
  });
  return editor;
}

describe("Plugin 商店试用预填后的输入框可继续编辑", () => {
  // 生产路径传的是显式 ""（ConversationComposer 把 request.text 切掉 markdown 前缀后为空串），
  // 不是缺省参数，所以这里必须用 "" 而不是 undefined，否则默认参数单独就能让测试变绿。
  it("空提示词试用也会在 mention token 后留下文本节点并把光标放在 token 之外", async () => {
    const editor = await prefill("");

    editor.getEditorState().read(() => {
      const children = $getRoot().getFirstChild()?.getChildren?.() ?? [];
      expect(children.map((node) => node.getType())).toEqual(["prompt-mention", "text"]);

      const selection = $getSelection();
      if (!$isRangeSelection(selection)) {
        throw new Error("预填后没有 range selection");
      }
      const anchorNode = selection.anchor.getNode();
      // 关键不变量：光标必须落在 mention 之后的普通文本节点里。
      // 停在 token 内部时，Lexical insertText 会整节点替换，用户按一下空格引用就消失。
      expect($isPromptMentionNode(anchorNode)).toBe(false);
      expect($isTextNode(anchorNode)).toBe(true);
      expect(anchorNode.getKey()).toBe(children[1]?.getKey());
    });
  });

  it("带示例提示词试用保持原有草稿正文", async () => {
    const editor = await prefill(" 帮我提交当前改动");

    expect(editor.getEditorState().read(() => $getPromptMarkdown())).toBe(
      `${TRY_NOW_MENTION.markdown} 帮我提交当前改动`,
    );
  });
});

describe("前置 Plugin mention 保留现有 Lexical 节点", () => {
  it("连续选择不同 Plugin 时保留旧 chip、文件 chip 与多段正文", () => {
    const editor = createEditor({ nodes: [PromptMentionNode] });
    editor.update(
      () => {
        $getRoot().append(
          $createParagraphNode().append(
            $createPromptMentionNode(TRY_NOW_MENTION),
            $createTextNode(" 正文"),
          ),
          $createParagraphNode().append(
            $createPromptMentionNode({
              id: "file:src/demo.ts",
              category: "files",
              label: "demo.ts",
              value: "src/demo.ts",
              markdown: "[demo.ts](src/demo.ts)",
              data: { path: "src/demo.ts" },
            }),
            $createTextNode(" "),
            $createPromptMentionNode({
              id: "prefill-skill:review",
              category: "skills",
              label: "review",
              value: "review",
              markdown: "$review",
            }),
            $createTextNode(" 第二段"),
          ),
        );
      },
      { discrete: true },
    );

    expect(prependEditorMentionIfMissing(editor, SECOND_PLUGIN_MENTION)).toBe(true);
    expect(prependEditorMentionIfMissing(editor, TRY_NOW_MENTION)).toBe(false);

    editor.getEditorState().read(() => {
      const paragraphs = $getRoot().getChildren();
      expect(paragraphs).toHaveLength(2);
      const mentionNodes = $getRoot()
        .getAllTextNodes()
        .filter($isPromptMentionNode);
      expect(mentionNodes.map((node) => node.getMention().id)).toEqual([
        SECOND_PLUGIN_MENTION.id,
        TRY_NOW_MENTION.id,
        "file:src/demo.ts",
        "prefill-skill:review",
      ]);
      expect($getPromptMarkdown()).toBe(
        `${SECOND_PLUGIN_MENTION.markdown} ${TRY_NOW_MENTION.markdown} 正文\n\n` +
          "[demo.ts](src/demo.ts) $review 第二段",
      );
    });
  });

  it("序列化恢复后仍保留两个 Plugin mention 节点", () => {
    const editor = createEditor({ nodes: [PromptMentionNode] });
    editor.update(
      () => {
        $getRoot().append($createParagraphNode().append($createPromptMentionNode(TRY_NOW_MENTION)));
      },
      { discrete: true },
    );
    prependEditorMentionIfMissing(editor, SECOND_PLUGIN_MENTION);

    const restored = createEditor({ nodes: [PromptMentionNode] });
    restored.setEditorState(restored.parseEditorState(JSON.stringify(editor.getEditorState())));
    restored.getEditorState().read(() => {
      const mentions = $getRoot().getAllTextNodes().filter($isPromptMentionNode);
      expect(mentions.map((node) => node.getMention().id)).toEqual([
        SECOND_PLUGIN_MENTION.id,
        TRY_NOW_MENTION.id,
      ]);
    });
  });
});

describe("菜单保存的 Lexical 选区", () => {
  it("草稿节点被替换后在新草稿末尾插入，不恢复失效 key", async () => {
    const editor = createEditor({
      nodes: [PromptMentionNode],
      onError: (error) => {
        throw error;
      },
    });
    editor.update(
      () => {
        const text = $createTextNode("old draft");
        $getRoot().append($createParagraphNode().append(text));
        text.select(3, 3);
      },
      { discrete: true },
    );
    const saved = editor.getEditorState();
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append($createParagraphNode().append($createTextNode("replacement ")));
      },
      { discrete: true },
    );
    await new Promise<void>((resolve) => {
      const unregister = editor.registerUpdateListener(() => {
        unregister();
        resolve();
      });
      insertEditorMention(editor, TRY_NOW_MENTION, saved);
    });
    expect(editor.getEditorState().read(() => $getPromptMarkdown())).toBe(
      "replacement " + TRY_NOW_MENTION.markdown + " ",
    );
  });
});
