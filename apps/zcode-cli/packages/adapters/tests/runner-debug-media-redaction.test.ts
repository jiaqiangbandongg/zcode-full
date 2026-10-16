// P1 回归：image/video dataUrl 不得全量落 model-io。
// 媒体 base64 会显著放大日志；video 还允许无上游压缩的 30MiB 输入，
// 单条请求即可突破 64MiB rollout 会话上限或把全量保留模式刷爆磁盘。
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordStreamTextDebug } from "../src/model/runner-debug.js";
import type {
  AiSdkModelTextRequest,
  AiSdkStreamTextOptions,
  AiSdkStreamTextResult,
  ResolvedAiSdkModel,
} from "../src/model/runner-runtime.js";

describe("model-io media dataUrl redaction", () => {
  let debugDir: string;

  beforeEach(async () => {
    debugDir = await mkdtemp(join(tmpdir(), "zcode-model-io-media-"));
  });

  afterEach(async () => {
    await rm(debugDir, { recursive: true, force: true });
  });

  const resolved = {
    providerId: "test-provider",
    modelId: "test-model",
    baseURL: "https://api.example.test",
    headers: {},
    providerKind: "anthropic",
  } as unknown as ResolvedAiSdkModel;

  async function writeAndReadMessage(
    content: unknown,
    options: {
      isDev?: boolean;
      modelIoFullRetentionEnabled?: boolean;
      providerBody?: unknown;
      sdkMessages?: unknown;
    } = {},
  ): Promise<string> {
    const request = {
      messages: [{ role: "user", content }],
      metadata: { sessionId: "sess-model-io-media" },
    } as unknown as AiSdkModelTextRequest;
    const result = {
      request: Promise.resolve({ body: options.providerBody }),
      response: Promise.resolve({ text: "ok" }),
    } as unknown as AiSdkStreamTextResult;
    await recordStreamTextDebug({
      attempt: 1,
      debugDir,
      isDev: options.isDev ?? false,
      modelIoFullRetentionEnabled: options.modelIoFullRetentionEnabled ?? false,
      normalizedToolCalls: [],
      options: { messages: options.sdkMessages ?? [] } as unknown as AiSdkStreamTextOptions,
      recordModelIO: true,
      request,
      requestId: "req-model-io-media",
      resolved,
      result,
      startedAt: Date.now(),
    });
    const file = join(debugDir, "model-io-sess-model-io-media.jsonl");
    return readFile(file, "utf-8");
  }

  it("video dataUrl 落盘前替换为占位", async () => {
    const payload = "video-model-io-sentinel";
    const fileText = await writeAndReadMessage([
      {
        type: "video",
        mediaType: "video/mp4",
        dataUrl: `data:video/mp4;base64,${payload}`,
      },
    ]);
    expect(fileText).toContain("[dataUrl omitted from model-io: video/mp4");
    expect(fileText).not.toContain(payload);
  });

  it("redacts image bytes from canonical, AI SDK, and provider records", async () => {
    const dataUrlPayload = "image-data-url-sentinel";
    const sdkPayload = "ai-sdk-image-sentinel";
    const providerPayload = "anthropic-image-sentinel";
    const fileText = await writeAndReadMessage(
      [
        {
          type: "image",
          mediaType: "image/png",
          dataUrl: `data:image/png;base64,${dataUrlPayload}`,
        },
      ],
      {
        isDev: true,
        sdkMessages: [
          {
            role: "user",
            content: [{ type: "image", mediaType: "image/png", image: sdkPayload }],
          },
        ],
        providerBody: {
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: providerPayload,
                  },
                },
              ],
            },
          ],
        },
      },
    );

    expect(fileText).toContain("[dataUrl omitted from model-io: image/png");
    expect(fileText).toContain("[image omitted from model-io: image/png");
    expect(fileText).toContain("[data omitted from model-io: image/png");
    expect(fileText).not.toContain(dataUrlPayload);
    expect(fileText).not.toContain(sdkPayload);
    expect(fileText).not.toContain(providerPayload);
  });

  it("redacts OpenAI video_url data URLs from the provider request body", async () => {
    const payload = "openai-video-wire-sentinel";
    const fileText = await writeAndReadMessage("video", {
      isDev: true,
      providerBody: {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "video_url",
                video_url: { url: `data:video/mp4;base64,${payload}` },
              },
            ],
          },
        ],
      },
    });

    expect(fileText).toContain("[url omitted from model-io: video/mp4");
    expect(fileText).not.toContain(payload);
  });

  it("redacts Anthropic base64 video sources in full-retention model-io", async () => {
    const payload = "anthropic-video-wire-sentinel";
    const fileText = await writeAndReadMessage("video", {
      modelIoFullRetentionEnabled: true,
      providerBody: {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "video",
                source: {
                  type: "base64",
                  media_type: "video/mp4",
                  data: payload,
                },
              },
            ],
          },
        ],
      },
    });

    expect(fileText).toContain("[data omitted from model-io: video/mp4");
    expect(fileText).not.toContain(payload);
  });

  it("redacts AI SDK video file data from model-io", async () => {
    const payload = "ai-sdk-video-file-sentinel";
    const fileText = await writeAndReadMessage("video", {
      isDev: true,
      sdkMessages: [
        {
          role: "user",
          content: [{ type: "file", mediaType: "video/mp4", data: payload }],
        },
      ],
    });

    expect(fileText).toContain("[data omitted from model-io: video/mp4");
    expect(fileText).not.toContain(payload);
  });

  it("redacts media data when MIME casing is non-canonical", async () => {
    const dataUrlPayload = "uppercase-data-url-sentinel";
    const rawPayload = "uppercase-raw-media-sentinel";
    const fileText = await writeAndReadMessage(
      [{ type: "video", dataUrl: `data:VIDEO/MP4;base64,${dataUrlPayload}` }],
      {
        isDev: true,
        sdkMessages: [
          {
            role: "user",
            content: [{ type: "file", mediaType: "IMAGE/PNG", data: rawPayload }],
          },
        ],
      },
    );

    expect(fileText).not.toContain(dataUrlPayload);
    expect(fileText).not.toContain(rawPayload);
  });
});
