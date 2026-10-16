import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendConversationSelectionReference,
  buildPromptWithConversationSelections,
  clearConversationSelectionReferenceScope,
  dispatchConversationSelectionAdd,
  getConversationSelectionReferenceScope,
  parsePromptConversationSelections,
  type ConversationSelectionReference,
} from "../src/lib/conversationSelectionReference.js";
import {
  buildPromptWithWebElementContexts,
  parsePromptWebElementContexts,
  type WebElementContextComposerAttachment,
} from "../src/lib/webElementContext.js";

function reference(
  id: string,
  sourceRowId = 1,
  text = "selected text",
): ConversationSelectionReference {
  return {
    contentType: "assistant",
    id,
    sourceRowId,
    sourceSessionId: "parent-1",
    text,
  };
}

describe("conversation selection references", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("在 composer 挂载前先写入 session scope，首次打开不会丢引用", () => {
    vi.stubGlobal("window", new EventTarget());
    const nextReference = reference("ref-before-mount");

    expect(
      dispatchConversationSelectionAdd({
        targetSessionId: "child-before-mount",
        workspaceKey: "/workspace",
        reference: nextReference,
      }),
    ).toMatchObject({ ok: true, duplicate: false });
    expect(getConversationSelectionReferenceScope("child-before-mount", "/workspace")).toEqual([
      nextReference,
    ]);

    clearConversationSelectionReferenceScope("child-before-mount", "/workspace");
  });

  it("按来源与原文去重，同文不同 row 保留", () => {
    const first = appendConversationSelectionReference([], reference("ref-1"));
    expect(first).toMatchObject({ ok: true, duplicate: false });
    if (!first.ok) return;

    const duplicate = appendConversationSelectionReference(first.references, reference("ref-2"));
    expect(duplicate).toMatchObject({ ok: true, duplicate: true });

    const otherRow = appendConversationSelectionReference(first.references, reference("ref-3", 2));
    expect(otherRow).toMatchObject({ ok: true, duplicate: false });
    if (otherRow.ok) expect(otherRow.references).toHaveLength(2);
  });

  it("超限原子拒绝，不截断或修改已有引用", () => {
    const existing = [reference("ref-existing", 1, "a".repeat(8_000))];
    const rejected = appendConversationSelectionReference(
      existing,
      reference("ref-next", 2, "b".repeat(8_001)),
    );

    expect(rejected).toEqual({ ok: false, reason: "single" });
    expect(existing).toHaveLength(1);
    expect(existing[0]?.text).toHaveLength(8_000);
  });

  it("新发送只序列化 userselect text，并恢复可见正文与 chips", () => {
    const references = [reference("ref-1"), reference("ref-2", 2, "second")];
    const prompt = buildPromptWithConversationSelections("Explain this", references);

    expect(prompt).toBe(
      [
        "Explain this",
        "",
        "# userselect:",
        "```userselect",
        JSON.stringify([{ text: "selected text" }, { text: "second" }]),
        "```",
      ].join("\n"),
    );
    expect(prompt).not.toContain("sourceSessionId");
    expect(prompt).not.toContain("sourceRowId");
    expect(prompt).not.toContain("contentType");
    expect(prompt).not.toContain('"id"');
    expect(parsePromptConversationSelections(prompt)).toEqual({
      visibleContent: "Explain this",
      references: [{ text: "selected text" }, { text: "second" }],
    });
  });

  it("文件路径随选段往返，普通对话与无路径 Markdown 不发送内部来源", () => {
    const file = {
      id: "md",
      contentType: "markdown" as const,
      sourceKey: "identity",
      sourceTitle: "note",
      path: "C:\\docs\\a.md",
      text: "excerpt",
    };
    const prompt = buildPromptWithConversationSelections("Explain", [
      file,
      reference("msg"),
      { ...file, path: undefined },
    ]);
    expect(parsePromptConversationSelections(prompt)).toEqual({
      visibleContent: "Explain",
      references: [
        { path: file.path, text: "excerpt" },
        { text: "selected text" },
        { text: "excerpt" },
      ],
    });
    expect(prompt).not.toContain("identity");
    expect(
      buildPromptWithConversationSelections(
        "Explain",
        parsePromptConversationSelections(prompt).references,
      ),
    ).toBe(prompt);
  });

  it.each([42, "", "   ", null])("非法文件路径不吞掉原文：%s", (path) => {
    const prompt =
      "# userselect:\n```userselect\n" + JSON.stringify([{ path, text: "excerpt" }]) + "\n```";
    expect(parsePromptConversationSelections(prompt)).toEqual({
      visibleContent: prompt,
      references: [],
    });
  });

  it("继续只读解析旧 Conversation selections 完整结构块", () => {
    const references = [reference("legacy-ref")];
    const legacyPrompt = [
      "Explain legacy",
      "",
      "# Conversation selections:",
      "```zcode-conversation-selections",
      JSON.stringify(references),
      "```",
    ].join("\n");

    expect(parsePromptConversationSelections(legacyPrompt)).toEqual({
      visibleContent: "Explain legacy",
      references,
    });
  });

  it("与 Web element block 共存且按发送端顺序逐层解析", () => {
    const webContext: WebElementContextComposerAttachment = {
      id: "web-1",
      pageTitle: "Example",
      pageUrl: "https://example.com",
      selector: "#submit",
      tagName: "button",
      text: "Submit",
      workspacePath: "/workspace",
    };
    const selectionReferences = [reference("ref-1")];
    const prompt = buildPromptWithWebElementContexts(
      buildPromptWithConversationSelections("Explain both", selectionReferences),
      [webContext],
    );
    const webParsed = parsePromptWebElementContexts(prompt, {
      workspacePath: "/workspace",
    });
    const selectionParsed = parsePromptConversationSelections(webParsed.visibleContent);

    expect(webParsed.webElementContexts).toHaveLength(1);
    expect(selectionParsed).toEqual({
      visibleContent: "Explain both",
      references: [{ text: "selected text" }],
    });
  });
});
