import { describe, expect, it } from "vitest";
import { toAiSdkMessages } from "../src/model/index.js";
import { createTestInputFormat } from "./test-model-format.js";

describe("AI SDK tool result media projection", () => {
  it("accepts case-insensitive data URL schemes for image tool results", () => {
    const messages = toAiSdkMessages(
      [
        {
          role: "tool",
          content: [
            {
              type: "image",
              mediaType: "image/png",
              dataUrl: "DATA:image/png;base64,aW1hZ2U=",
            },
          ],
          toolCallId: "call_uppercase_data",
          toolName: "image_tool",
        },
      ],
      { providerKind: "anthropic", supportsImages: true },
    );

    expect((messages[0] as any).content[0].output.value).toEqual([
      { type: "image-data", data: "aW1hZ2U=", mediaType: "image/png" },
    ]);
  });

  it("preserves a real Anthropic CUA observation result in order", () => {
    const frameRef = JSON.stringify({
      image_ref: { frame_id: "frame-complete", width: 1, height: 1, actionable: true },
    });
    const state = "state_id=state-complete mode=full\nSTATE_MARKER";
    const appInstructions = "<app_specific_instructions>APP_MARKER</app_specific_instructions>";
    const messages = toAiSdkMessages(
      [
        {
          role: "tool",
          content: [
            {
              type: "image",
              mediaType: "image/png",
              dataUrl: "data:image/png;base64,aW1hZ2U=",
            },
            { type: "text", text: frameRef },
            { type: "text", text: state },
            { type: "text", text: appInstructions },
          ],
          toolCallId: "call_complete",
          toolName: "mcp__computer-use__get_app_state",
        },
      ],
      { providerKind: "anthropic", supportsImages: true },
    );

    expect(messages).toHaveLength(1);
    expect((messages[0] as any).content[0].output).toEqual({
      type: "content",
      value: [
        { type: "image-data", data: "aW1hZ2U=", mediaType: "image/png" },
        { type: "text", text: frameRef },
        { type: "text", text: state },
        { type: "text", text: appInstructions },
      ],
    });
  });

  it("preserves a real Anthropic CUA action result in order", () => {
    const note = "Action dispatched. (settled state below)";
    const state = "state_id=state-action mode=full\nACTION_STATE";
    const outcome = JSON.stringify({
      schema_version: "zcode-cua-action-outcome-v1",
      state_sync_status: "synced",
      post_state_id: "state-action",
      state_available: true,
    });
    const messages = toAiSdkMessages(
      [
        {
          role: "tool",
          content: [
            { type: "text", text: note },
            { type: "text", text: state },
            { type: "text", text: outcome },
          ],
          toolCallId: "call_action",
          toolName: "mcp__computer-use__left_click",
        },
      ],
      { providerKind: "anthropic" },
    );

    expect((messages[0] as any).content[0].output.value).toEqual([
      { type: "text", text: note },
      { type: "text", text: state },
      { type: "text", text: outcome },
    ]);
  });

  it("preserves text around media across consecutive Anthropic tool results", () => {
    const messages = toAiSdkMessages(
      [
        {
          role: "tool",
          content: [
            { type: "text", text: "BEFORE_IMAGE" },
            {
              type: "image",
              mediaType: "image/png",
              dataUrl: "data:image/png;base64,aW1hZ2U=",
            },
            { type: "text", text: "AFTER_IMAGE" },
          ],
          toolCallId: "call_mixed",
          toolName: "mixed_result",
        },
        {
          role: "tool",
          content: "SECOND_RESULT",
          toolCallId: "call_second",
          toolName: "second_result",
        },
      ],
      { providerKind: "anthropic", supportsImages: true },
    );

    expect(messages).toHaveLength(2);
    expect((messages[0] as any).content[0].output.value).toEqual([
      { type: "text", text: "BEFORE_IMAGE" },
      { type: "image-data", data: "aW1hZ2U=", mediaType: "image/png" },
      { type: "text", text: "AFTER_IMAGE" },
    ]);
    expect((messages[1] as any).content[0].output).toEqual({
      type: "text",
      value: "SECOND_RESULT",
    });
  });

  it("keeps every text marker in an Anthropic error result", () => {
    const messages = toAiSdkMessages(
      [
        {
          role: "tool",
          content: [
            { type: "text", text: "ERROR_MARKER_A" },
            { type: "text", text: "ERROR_MARKER_B" },
          ],
          isError: true,
          toolCallId: "call_error",
          toolName: "mcp__computer-use__get_app_state",
        },
      ],
      { providerKind: "anthropic" },
    );

    const output = (messages[0] as any).content[0].output;
    expect(output.type).toBe("error-text");
    expect(output.value).toContain("ERROR_MARKER_A");
    expect(output.value).toContain("ERROR_MARKER_B");
  });

  it("projects OpenAI-compatible tool images through a follow-up user media message", () => {
    const toolCallId = "call_read_image";
    const messages = toAiSdkMessages(
      [
        {
          role: "tool",
          content: [
            {
              type: "image",
              mediaType: "image/jpeg",
              dataUrl: "data:image/jpeg;base64,cmVhZC1pbWFnZQ==",
              source: { id: "read-image", kind: "inline", placeholder: "Read image" },
            },
          ],
          toolCallId,
          toolName: "Read",
        },
      ],
      { providerKind: "openai-compatible" },
    );

    expect(messages).toEqual([
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId,
            toolName: "Read",
            output: {
              type: "text",
              value: "[Attached image/jpeg: Read image]",
            },
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Tool result media from Read:" },
          { type: "image", image: "cmVhZC1pbWFnZQ==", mediaType: "image/jpeg" },
        ],
      },
    ]);
  });

  it("keeps PDF page results structured for Anthropic and Responses, and textifies only Chat", () => {
    const content = [
      { type: "text" as const, text: "PDF pages extracted: 2 page(s) from /tmp/report.pdf (2KB)" },
      {
        type: "image" as const,
        mediaType: "image/jpeg",
        dataUrl: "data:image/jpeg;base64,cGFnZS0x",
      },
      {
        type: "image" as const,
        mediaType: "image/jpeg",
        dataUrl: "data:image/jpeg;base64,cGFnZS0y",
      },
    ];
    const input = [{ role: "tool" as const, content, toolCallId: "call_pdf", toolName: "Read" }];
    const structuredOutput = {
      type: "content",
      value: [
        { type: "text", text: "PDF pages extracted: 2 page(s) from /tmp/report.pdf (2KB)" },
        { type: "image-data", data: "cGFnZS0x", mediaType: "image/jpeg" },
        { type: "image-data", data: "cGFnZS0y", mediaType: "image/jpeg" },
      ],
    };

    const anthropic = toAiSdkMessages(input, {
      apiFormat: "anthropic-messages",
      providerKind: "anthropic",
      supportsImages: true,
    });
    expect(anthropic).toHaveLength(1);
    expect((anthropic[0] as any).content[0].output).toEqual(structuredOutput);

    const responses = toAiSdkMessages(input, {
      apiFormat: "openai-responses",
      providerKind: "openai",
      supportsImages: true,
    });
    expect(responses).toHaveLength(1);
    expect((responses[0] as any).content[0].output).toEqual(structuredOutput);

    const chat = toAiSdkMessages(input, {
      apiFormat: "openai-chat-completions",
      providerKind: "openai",
      supportsImages: true,
    });
    expect(chat).toEqual([
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_pdf",
            toolName: "Read",
            output: {
              type: "text",
              value:
                "PDF pages extracted: 2 page(s) from /tmp/report.pdf (2KB)\n\n[Attached image/jpeg]\n\n[Attached image/jpeg]",
            },
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Tool result media from Read:" },
          { type: "image", image: "cGFnZS0x", mediaType: "image/jpeg" },
          { type: "image", image: "cGFnZS0y", mediaType: "image/jpeg" },
        ],
      },
    ]);
  });

  it("keeps OpenAI Responses tool media structured when apiFormat is omitted", () => {
    const messages = toAiSdkMessages(
      [
        {
          role: "tool",
          content: [
            { type: "text", text: "PDF pages extracted: 1 page(s) from /tmp/report.pdf (1KB)" },
            {
              type: "image",
              mediaType: "image/jpeg",
              dataUrl: "data:image/jpeg;base64,cGFnZS0x",
            },
          ],
          toolCallId: "call_pdf_responses",
          toolName: "Read",
        },
      ],
      { providerKind: "openai", supportsImages: true },
    );

    expect(messages).toHaveLength(1);
    expect((messages[0] as any).content[0].output).toEqual({
      type: "content",
      value: [
        { type: "text", text: "PDF pages extracted: 1 page(s) from /tmp/report.pdf (1KB)" },
        { type: "image-data", data: "cGFnZS0x", mediaType: "image/jpeg" },
      ],
    });
  });

  it("keeps follow-up media after a contiguous OpenAI-compatible tool result block", () => {
    const messages = toAiSdkMessages(
      [
        {
          role: "tool",
          content: [
            {
              type: "image",
              mediaType: "image/png",
              dataUrl: "data:image/png;base64,aW1hZ2U=",
            },
          ],
          toolCallId: "call_image",
          toolName: "Read",
        },
        {
          role: "tool",
          content: "ok",
          toolCallId: "call_text",
          toolName: "Read",
        },
      ],
      { providerKind: "openai-compatible" },
    );

    expect(messages.map((message) => message.role)).toEqual(["tool", "tool", "user"]);
    expect((messages[0] as any).content[0].output).toEqual({
      type: "text",
      value: "[Attached image/png]",
    });
    expect((messages[1] as any).content[0].output).toEqual({
      type: "text",
      value: "ok",
    });
    expect((messages[2] as any).content).toEqual([
      { type: "text", text: "Tool result media from Read:" },
      { type: "image", image: "aW1hZ2U=", mediaType: "image/png" },
    ]);
  });

  it("does not project OpenAI-compatible tool images when images are explicitly unsupported", () => {
    const messages = toAiSdkMessages(
      [
        {
          role: "tool",
          content: [
            {
              type: "image",
              mediaType: "image/png",
              dataUrl: "data:image/png;base64,aW1hZ2U=",
            },
          ],
          toolCallId: "call_image",
          toolName: "Read",
        },
      ],
      {
        providerKind: "openai-compatible",
        inputFormat: createTestInputFormat({ supportsImage: false }),
      },
    );

    expect(messages).toHaveLength(1);
    expect((messages[0] as any).content[0].output).toEqual({
      type: "text",
      value:
        "[Attached image/png]\n[Media omitted from provider request because the selected model does not support image input.]",
    });
  });

  it("textifies OpenAI-compatible structured tool text instead of JSON content", () => {
    const messages = toAiSdkMessages(
      [
        {
          role: "tool",
          content: [{ type: "text", text: "plain result" }],
          toolCallId: "call_text_block",
          toolName: "Example",
        },
      ],
      { providerKind: "openai-compatible" },
    );

    expect((messages[0] as any).content[0].output).toEqual({
      type: "text",
      value: "plain result",
    });
    expect(messages).toHaveLength(1);
  });

  it("does not pair a text block that is separated from the media by another block", () => {
    const messages = toAiSdkMessages(
      [
        {
          role: "tool",
          content: [
            { type: "text", text: "summary before state" },
            { type: "reasoning" as never, text: "" },
            { type: "text", text: "captured state" },
            {
              type: "image",
              mediaType: "image/png",
              dataUrl: "data:image/png;base64,c3RhdGU=",
            },
          ],
          toolCallId: "call_sep",
          toolName: "inspect",
        },
      ],
      { providerKind: "openai-compatible" },
    );

    // 谓词化后：普通文本不是媒体凭证，无论是否紧邻都不配对、不延后
    // （配对只对 producer 签发的帧凭证生效）。
    const toolOutput = (messages[0] as any).content[0].output.value as string;
    expect(toolOutput).toContain("summary before state");
    expect(toolOutput).toContain("captured state");
    const mediaTexts = ((messages[1] as any).content as Array<Record<string, unknown>>)
      .filter((part) => part.type === "text")
      .map((part) => part.text);
    expect(mediaTexts.some((text) => String(text).includes("captured state"))).toBe(false);
  });
  it("keeps a non-paired description text in the tool output when it is followed by another text before the image (SG-01)", () => {
    const messages = toAiSdkMessages(
      [
        {
          role: "tool",
          content: [
            { type: "text", text: "处理失败：超时" },
            { type: "text", text: "附下方截图供诊断" },
            {
              type: "image",
              mediaType: "image/png",
              dataUrl: "data:image/png;base64,ZGlhZw==",
            },
          ],
          toolCallId: "call_plain_tool",
          toolName: "plain_check",
        },
      ],
      { providerKind: "openai-compatible" },
    );

    // 谓词化后：普通 caption 不是媒体凭证，留在 tool result 不迁移；
    // 通用工具的媒体语义保持 pre-CUA 行为（只有帧凭证才配对）。
    const toolOutput = (messages[0] as any).content[0].output.value as string;
    expect(toolOutput).toContain("处理失败：超时");
    expect(toolOutput).toContain("附下方截图供诊断");
    const mediaTexts = ((messages[1] as any).content as Array<Record<string, unknown>>)
      .filter((part) => part.type === "text")
      .map((part) => String(part.text));
    expect(mediaTexts.some((text) => text.includes("附下方截图供诊断"))).toBe(false);
  });

  it("defers a plain screenshot caption with its image for any structured tool (generic pairing)", () => {
    const messages = toAiSdkMessages(
      [
        {
          role: "tool",
          content: [
            { type: "text", text: "Chart of weekly commits:" },
            {
              type: "image",
              mediaType: "image/svg+xml",
              dataUrl: "data:image/svg+xml;base64,Y2hhcnQ=",
            },
          ],
          toolCallId: "call_chart",
          toolName: "render_chart",
        },
      ],
      { providerKind: "openai-compatible" },
    );

    // 谓词化后：普通 chart 说明不是媒体凭证，留在 tool result；图片字节
    // 原样延后（配对只对 producer 签发的帧凭证生效，通用语义回归 pre-CUA）。
    const toolOutput = (messages[0] as any).content[0].output.value as string;
    expect(toolOutput).toContain("Chart of weekly commits:");
    const mediaContent = (messages[1] as any).content as Array<Record<string, unknown>>;
    expect(
      mediaContent.some(
        (part) => part.type === "text" && String(part.text).includes("Chart of weekly commits:"),
      ),
    ).toBe(false);
    expect(mediaContent.some((part) => part.type === "image" && part.image === "Y2hhcnQ=")).toBe(
      true,
    );
  });

  it("keeps standalone text untouched when the tool result has no media at all", () => {
    const messages = toAiSdkMessages(
      [
        {
          role: "tool",
          content: [
            { type: "text", text: "3 files changed" },
            { type: "text", text: "no media here" },
          ],
          toolCallId: "call_summary",
          toolName: "diff_summary",
        },
      ],
      { providerKind: "gateway" },
    );

    // 无 media：没有任何配对,全部文本原样留在 tool result。
    expect(messages).toHaveLength(1);
    const toolOutput = (messages[0] as any).content[0].output.value as string;
    expect(toolOutput).toContain("3 files changed");
    expect(toolOutput).toContain("no media here");
  });
  it("keeps the caption in the tool text when the model cannot receive that media kind (no orphan deferred text)", () => {
    const messages = toAiSdkMessages(
      [
        {
          role: "tool",
          content: [
            { type: "text", text: "CAPTION_BEFORE_IMAGE" },
            { type: "image", mediaType: "image/png", dataUrl: "data:image/png;base64,aGVsbG8=" },
          ],
          toolCallId: "call_novision",
          toolName: "screenshot",
        },
      ],
      {
        providerKind: "openai-compatible",
        inputFormat: createTestInputFormat({ supportsImage: false }),
      },
    );

    // 媒体不可投递时不产生延后消息；配对文本留在 tool result（带省略占位说明）。
    expect(messages).toHaveLength(1);
    const toolOutput = (messages[0] as any).content[0].output.value as string;
    expect(toolOutput).toContain("CAPTION_BEFORE_IMAGE");
    expect(toolOutput).toContain("does not support image input");
  });

  it("does not drop paired text when stripMedia suppresses deferral entirely (SG-02)", () => {
    const messages = toAiSdkMessages(
      [
        {
          role: "tool",
          content: [
            { type: "text", text: "CAPTION" },
            { type: "image", mediaType: "image/png", dataUrl: "data:image/png;base64,aGVsbG8=" },
          ],
          toolCallId: "c3",
          toolName: "plain_tool",
        },
      ],
      { providerKind: "openai-compatible", stripMedia: true },
    );
    // stripMedia：无延后消息；配对文本不从 tool 输出消失（两头守卫一致）。
    expect(messages).toHaveLength(1);
    const output = (messages[0] as any).content[0].output;
    expect(output.type === "text" ? output.value : JSON.stringify(output)).toContain("CAPTION");
  });
});
