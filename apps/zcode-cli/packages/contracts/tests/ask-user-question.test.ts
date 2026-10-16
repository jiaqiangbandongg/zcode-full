import { describe, expect, it } from "vitest";
import {
  AskUserQuestionAnsweredInputSchema,
  AskUserQuestionInputSchema,
} from "../src/tools/ask-user-question.js";

const validInput = {
  questions: [
    {
      header: "Library",
      question: "Which date library should we use?",
      options: [
        { label: "date-fns", description: "Small functional helpers" },
        { label: "Luxon", description: "Richer timezone model" },
      ],
    },
  ],
};

describe("AskUserQuestion contracts", () => {
  it("accepts a valid single-select question", () => {
    const parsed = AskUserQuestionInputSchema.parse(validInput);

    expect(parsed.questions[0]?.multiSelect).toBe(false);
  });

  it("rejects duplicate question text", () => {
    const result = AskUserQuestionInputSchema.safeParse({
      questions: [validInput.questions[0], validInput.questions[0]],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("Question texts must be unique");
  });

  it("rejects duplicate option labels and model-provided Other", () => {
    const duplicate = AskUserQuestionInputSchema.safeParse({
      questions: [
        {
          header: "Choice",
          question: "Which option should we use?",
          options: [
            { label: "Same", description: "First" },
            { label: "Same", description: "Second" },
          ],
        },
      ],
    });
    const other = AskUserQuestionInputSchema.safeParse({
      questions: [
        {
          header: "Choice",
          question: "Which option should we use?",
          options: [
            { label: "Recommended", description: "Use the recommended path" },
            { label: "Other", description: "Custom answer" },
          ],
        },
      ],
    });

    expect(duplicate.success).toBe(false);
    expect(duplicate.error?.issues[0]?.message).toContain("Option labels must be unique");
    expect(other.success).toBe(false);
    expect(other.error?.issues[0]?.message).toContain("Do not include an Other option");
  });

  it("requires the interaction to collect an answers field before execution", () => {
    const missing = AskUserQuestionAnsweredInputSchema.safeParse(validInput);
    const answered = AskUserQuestionAnsweredInputSchema.safeParse({
      ...validInput,
      answers: {
        "Which date library should we use?": "date-fns",
      },
    });

    expect(missing.success).toBe(false);
    expect(answered.success).toBe(true);
  });

  it("accepts partial answers without requiring every question", () => {
    const partial = AskUserQuestionAnsweredInputSchema.safeParse({
      questions: [
        validInput.questions[0],
        {
          header: "Runtime",
          question: "Which runtime should we target?",
          options: [
            { label: "Node", description: "Target Node.js" },
            { label: "Browser", description: "Target browsers" },
          ],
        },
      ],
      answers: {
        "Which runtime should we target?": "Node",
      },
    });

    expect(partial.success).toBe(true);
  });

  it("rejects blank values while still allowing omitted answers", () => {
    const blank = AskUserQuestionAnsweredInputSchema.safeParse({
      ...validInput,
      answers: { "Which date library should we use?": "   " },
    });

    expect(blank.success).toBe(false);
    expect(blank.error?.issues[0]?.message).toContain("Blank answer is not allowed");
  });

  it("accepts an explicit empty answer map for automatic continuation", () => {
    const autoResolved = AskUserQuestionAnsweredInputSchema.safeParse({
      ...validInput,
      answers: {},
    });

    expect(autoResolved.success).toBe(true);
  });

  it("accepts markdown and valid HTML fragment previews", () => {
    const markdown = AskUserQuestionInputSchema.safeParse(
      inputWithPreview("Use `Array<string>` for typed lists."),
    );
    const html = AskUserQuestionInputSchema.safeParse(
      inputWithPreview("<section><h2>Dense table</h2><p>Shows every file.</p></section>"),
    );

    expect(markdown.success).toBe(true);
    expect(html.success).toBe(true);
  });

  it("rejects unsafe or document-shaped HTML previews", () => {
    const documentPreview = AskUserQuestionInputSchema.safeParse(
      inputWithPreview("<!doctype html><html><body>Full page</body></html>"),
    );
    const scriptedPreview = AskUserQuestionInputSchema.safeParse(
      inputWithPreview("<div>Preview</div><script>alert(1)</script>"),
    );
    const stylePreview = AskUserQuestionInputSchema.safeParse(
      inputWithPreview("<style>.x{color:red}</style><div>Preview</div>"),
    );
    const commentOnlyPreview = AskUserQuestionInputSchema.safeParse(
      inputWithPreview("<!-- no visible tag -->"),
    );

    expect(documentPreview.success).toBe(false);
    expect(documentPreview.error?.issues[0]?.message).toContain("fragment");
    expect(scriptedPreview.success).toBe(false);
    expect(scriptedPreview.error?.issues[0]?.message).toContain("script or style");
    expect(stylePreview.success).toBe(false);
    expect(stylePreview.error?.issues[0]?.message).toContain("script or style");
    expect(commentOnlyPreview.success).toBe(false);
    expect(commentOnlyPreview.error?.issues[0]?.message).toContain("HTML tag");
  });
});

function inputWithPreview(preview: string): typeof validInput {
  return {
    questions: [
      {
        ...validInput.questions[0],
        options: [
          { label: "Compact", description: "Small layout", preview },
          { label: "Detailed", description: "Expanded layout" },
        ],
      },
    ],
  };
}
