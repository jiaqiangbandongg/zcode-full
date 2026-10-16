// video 输入的 wire 形状测试：
// - openai-compatible: video block → {type:"video_url", video_url:{url:"data:..."}}
// - anthropic:         video block → {type:"video", source:{type:"base64",...}}
// - tool result（Read 视频）媒体拆后置 user part（全 provider kind）
// - inputFormat.supportsVideo=false 时 strip 为占位文本（wire 不出现视频内容）
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import type { ModelMessageContent } from "@zcode/contracts";
import { createGenerateTextOptions } from "../src/model/runner-options.js";
import type { ResolvedAiSdkModel } from "../src/model/runner-runtime.js";
import { createTestModelProperties } from "./test-model-format.js";

const VIDEO_BASE64 = Buffer.from("fake-mp4-bytes").toString("base64");
const VIDEO_DATA_URL = `data:video/mp4;base64,${VIDEO_BASE64}`;

function videoBlock() {
  return {
    type: "video" as const,
    mediaType: "video/mp4",
    dataUrl: VIDEO_DATA_URL,
    source: {
      id: "turn-attachment-1",
      kind: "inline" as const,
      mimeType: "video/mp4",
      placeholder: "demo.mp4",
    },
  };
}

describe("Video input wire shape", () => {
  it("openai-compatible serializes video as video_url with a data URL", async () => {
    const body = await captureProviderBody("openai-compatible", {
      messages: [{ role: "user", content: [videoBlock(), { type: "text", text: "summarize" }] }],
    });

    expect(body?.messages?.[0]).toMatchObject({
      role: "user",
      content: [
        { type: "video_url", video_url: { url: VIDEO_DATA_URL } },
        { type: "text", text: "summarize" },
      ],
    });
  });

  it("anthropic serializes video as a base64 video block", async () => {
    const body = await captureProviderBody("anthropic", {
      messages: [{ role: "user", content: [videoBlock(), { type: "text", text: "summarize" }] }],
    });

    expect(body?.messages?.[0]).toMatchObject({
      role: "user",
      content: [
        {
          type: "video",
          source: { type: "base64", media_type: "video/mp4", data: VIDEO_BASE64 },
        },
        { type: "text", text: "summarize" },
      ],
    });
  });

  it("openai-compatible projects Read tool-result video into a follow-up user part", async () => {
    const body = await captureProviderBody("openai-compatible", {
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "reading" }],
          toolCalls: [{ id: "call_1", name: "Read", input: { file_path: "/tmp/demo.mp4" } }],
        },
        {
          role: "tool",
          toolCallId: "call_1",
          toolName: "Read",
          content: [videoBlock()],
        },
      ],
    });

    const messages = body?.messages as Array<Record<string, unknown>>;
    expect(messages).toBeDefined();
    const userMessages = messages.filter((message) => message.role === "user");
    const mediaUserMessage = userMessages.find((message) =>
      JSON.stringify(message).includes("Tool result media from Read:"),
    );
    expect(mediaUserMessage).toBeDefined();
    expect(JSON.stringify(mediaUserMessage)).toContain('"type":"video_url"');
  });

  it("anthropic also projects Read tool-result video into a follow-up user part", async () => {
    const body = await captureProviderBody("anthropic", {
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "reading" }],
          toolCalls: [{ id: "call_1", name: "Read", input: { file_path: "/tmp/demo.mp4" } }],
        },
        {
          role: "tool",
          toolCallId: "call_1",
          toolName: "Read",
          content: [videoBlock()],
        },
      ],
    });

    const serialized = JSON.stringify(body?.messages);
    expect(serialized).toContain("Tool result media from Read:");
    expect(serialized).toContain('"type":"video"');
    expect(serialized).toContain(VIDEO_BASE64);
  });

  it("strips video to placeholder text when the model does not support video", async () => {
    const body = await captureProviderBody("openai-compatible", {
      messages: [{ role: "user", content: [videoBlock()] }],
      supportVideo: false,
    });

    const serialized = JSON.stringify(body?.messages);
    expect(serialized).not.toContain("video_url");
    expect(serialized).toContain("does not support video input");
  });
});

interface CaptureProviderBodyInput {
  messages: Array<{
    role: string;
    content: ModelMessageContent;
    toolCalls?: unknown[];
    toolCallId?: string;
    toolName?: string;
  }>;
  supportVideo?: boolean;
}

async function captureProviderBody(
  providerKind: "anthropic" | "openai-compatible",
  input: CaptureProviderBodyInput,
): Promise<Record<string, unknown> | undefined> {
  let capturedBody: Record<string, unknown> | undefined;
  const baseURL =
    providerKind === "anthropic" ? "https://example.com/v1" : "https://api.example.test/v1";
  const providerId = providerKind === "anthropic" ? "custom-anthropic" : "custom-compatible";
  const captureFetch = async (_request: RequestInfo | URL, init?: RequestInit) => {
    if (typeof init?.body !== "string") {
      throw new Error("Expected a JSON request body");
    }
    capturedBody = JSON.parse(init.body) as Record<string, unknown>;
    return new Response(
      JSON.stringify(
        providerKind === "anthropic"
          ? {
              content: [{ text: "ok", type: "text" }],
              id: "msg_video_wire",
              model: "glm-5v-turbo",
              role: "assistant",
              stop_reason: "end_turn",
              stop_sequence: null,
              type: "message",
              usage: { input_tokens: 1, output_tokens: 1 },
            }
          : {
              choices: [{ finish_reason: "stop", message: { content: "ok", role: "assistant" } }],
              id: "chatcmpl-video-wire",
              model: "glm-5v-turbo",
            },
      ),
      { headers: { "content-type": "application/json" } },
    );
  };
  const model =
    providerKind === "anthropic"
      ? createAnthropic({ apiKey: "fake-ak", baseURL, fetch: captureFetch })("glm-5v-turbo")
      : createOpenAICompatible({
          apiKey: "fake-ak",
          baseURL,
          name: "video wire",
          fetch: captureFetch,
        })("glm-5v-turbo");
  const options = createGenerateTextOptions({
    includeModelIO: false,
    request: {
      messages: input.messages as never,
    },
    resolved: {
      baseURL,
      properties: createTestModelProperties({ supportsVideo: input.supportVideo ?? true }),
      model,
      providerKind,
      providerId,
      modelId: "glm-5v-turbo",
    } as ResolvedAiSdkModel,
    statusContext: {
      providerId,
      modelId: "glm-5v-turbo",
      providerKind,
      requestId: `req_video_wire_${providerKind}`,
      sessionId: `sess_video_wire_${providerKind}`,
      traceContext: { traceId: `trace_video_wire_${providerKind}` },
    } as never,
  });

  await generateText(options);
  return capturedBody;
}
