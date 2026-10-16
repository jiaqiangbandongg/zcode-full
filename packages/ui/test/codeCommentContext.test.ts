import { describe, expect, it } from "vitest";
import {
  buildPromptWithCodeComments,
  parsePromptCodeComments,
  type CodeCommentComposerAttachment,
} from "@/lib/codeCommentContext.js";

describe("buildPromptWithCodeComments", () => {
  const baseComment: CodeCommentComposerAttachment = {
    id: "comment-1",
    workspacePath: "/workspace",
    sourcePath: "/workspace/src/app.ts",
    sourceTitle: "app.ts",
    startLine: 17,
    endLine: 17,
    selectedText: "const value = 1;",
    comment: "Rename this value.",
    contextLabel: "Code context",
    commentLabel: "Comment",
  };

  it("keeps the typed prompt and appends code comment markdown at send time", () => {
    const prompt = buildPromptWithCodeComments("Please fix this", [baseComment]);

    expect(prompt).toContain("Please fix this");
    expect(prompt).toContain("# Code comments:");
    expect(prompt).toContain("File: /workspace/src/app.ts");
    expect(prompt).toContain("Lines: 17");
    expect(prompt).toContain("const value = 1;");
    expect(prompt).toContain("Comment:\nRename this value.");
  });

  it("supports multiple comments without requiring visible composer text", () => {
    const prompt = buildPromptWithCodeComments("", [
      baseComment,
      {
        ...baseComment,
        id: "comment-2",
        startLine: 20,
        endLine: 22,
        selectedText: "run();",
        comment: "Check the range.",
      },
    ]);

    expect(prompt).toContain("## Comment 1");
    expect(prompt).toContain("Lines: 17");
    expect(prompt).toContain("## Comment 2");
    expect(prompt).toContain("Lines: 20-22");
    expect(prompt).toContain("Check the range.");
  });

  it("parses code comment blocks back into visible content and attachments", () => {
    const prompt = buildPromptWithCodeComments("Please fix this", [
      baseComment,
      {
        ...baseComment,
        id: "comment-2",
        startLine: 20,
        endLine: 22,
        selectedText: "run();",
        comment: "Check the range.",
      },
    ]);

    const parsed = parsePromptCodeComments(prompt, {
      workspacePath: "/workspace",
    });

    expect(parsed.visibleContent).toBe("Please fix this");
    expect(parsed.codeCommentAttachments).toHaveLength(2);
    expect(parsed.codeCommentAttachments[0]).toMatchObject({
      workspacePath: "/workspace",
      sourcePath: "/workspace/src/app.ts",
      sourceTitle: "app.ts",
      startLine: 17,
      endLine: 17,
      selectedText: "const value = 1;",
      comment: "Rename this value.",
    });
    expect(parsed.codeCommentAttachments[1]).toMatchObject({
      startLine: 20,
      endLine: 22,
      selectedText: "run();",
      comment: "Check the range.",
    });
  });

  it("allows adding selected code to chat without writing a comment", () => {
    const prompt = buildPromptWithCodeComments("Please inspect this", [
      {
        ...baseComment,
        comment: "",
      },
    ]);

    expect(prompt).toContain("# Code comments:");
    expect(prompt).toContain("Selected text:");
    expect(prompt).toContain("Comment:");

    const parsed = parsePromptCodeComments(prompt, {
      workspacePath: "/workspace",
    });

    expect(parsed.visibleContent).toBe("Please inspect this");
    expect(parsed.codeCommentAttachments).toHaveLength(1);
    expect(parsed.codeCommentAttachments[0]).toMatchObject({
      sourcePath: "/workspace/src/app.ts",
      selectedText: "const value = 1;",
      comment: "",
    });
  });
});
