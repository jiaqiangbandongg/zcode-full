import { readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";

import {
  createModelId,
  createModelProviderId,
  type ModelInputMessage,
  type ModelToolContract,
} from "@zcode/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  TestAiSdkModelAdapter as AiSdkModelAdapter,
  TestProviderConfigFixture,
} from "./test-provider-config.js";
import { executeAdapterGenerateText, executeAdapterStreamText } from "./test-adapter-model.js";

const MEMORY_ROOT = "/storage/memories/project/memory";
const MODEL = {
  modelId: createModelId("claude-opus-4-8-cc"),
  providerId: createModelProviderId("anthropic"),
};
const MAIN_MEMORY = memoryFixture("main-memory-default-index.md").replaceAll(
  "<MEMORY_ROOT>",
  MEMORY_ROOT,
);
const SEMANTIC_RECALL_MAIN_MEMORY = memoryFixture("main-memory-semantic-recall.md").replaceAll(
  "<MEMORY_ROOT>",
  MEMORY_ROOT,
);
const MAIN_MEMORY_INDEX = memoryFixture("main-memory-index.md").replaceAll(
  "<MEMORY_INDEX_PATH>",
  `${MEMORY_ROOT}/MEMORY.md`,
);
const RECALLED_MEMORY = memoryFixture("recalled-memory.md", true).replaceAll(
  "<MEMORY_ROOT>",
  MEMORY_ROOT,
);
const EXTRACTION_PROMPT = memoryFixture("extraction-prompt.md").replaceAll(
  "<TIMESTAMP>",
  "2026-07-16T00:00:00.000Z",
);
const DREAM_PROMPT = memoryFixture("dream-prompt.md")
  .replaceAll("<MEMORY_ROOT>", MEMORY_ROOT)
  .replaceAll("<SESSION_TRANSCRIPT_ROOT>", "/storage/rollout")
  .replaceAll("<SESSION_ID>", "sess-history");
const MEMORY_UPDATE = memoryFixture("memory-update.md").replaceAll("<MEMORY_ROOT>", MEMORY_ROOT);
const CUSTOM_AGENT_MEMORY = memoryFixture("custom-agent-memory.md");
const CUSTOM_AGENT_SCOPE_GUIDANCE = JSON.parse(
  memoryFixture("custom-agent-scope-guidance.json", true),
) as Record<"local" | "project" | "user", string>;

const MEMORY_TOOLS: ModelToolContract[] = [
  {
    description: "Write a file",
    inputSchema: {
      additionalProperties: false,
      properties: {
        content: { type: "string" },
        file_path: { type: "string" },
      },
      required: ["file_path", "content"],
      type: "object",
    },
    name: "Write",
  },
  {
    description: "Edit a file",
    inputSchema: {
      additionalProperties: false,
      properties: {
        file_path: { type: "string" },
        new_string: { type: "string" },
        old_string: { type: "string" },
      },
      required: ["file_path", "old_string", "new_string"],
      type: "object",
    },
    name: "Edit",
  },
];

const openServers: Server[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(closeServer));
});

describe("Memory provider-visible request body", () => {
  it("keeps default-index and semantic-recall provider bodies mutually exclusive", async () => {
    const capture = await startProviderBodyCapture();
    const adapter = createAdapter(capture.baseURL);

    await sendStreamingRequest(adapter, [
      systemMessage(MAIN_MEMORY, true),
      userMessage(MAIN_MEMORY_INDEX),
      userMessage("default branch", true),
    ]);
    await sendStreamingRequest(adapter, [
      systemMessage(SEMANTIC_RECALL_MAIN_MEMORY, true),
      userMessage("semantic branch tool batch", true),
      systemMessage(RECALLED_MEMORY),
    ]);

    expect(capture.bodies).toHaveLength(2);
    const defaultText = requestBodyText(capture.bodies[0]!);
    const semanticText = requestBodyText(capture.bodies[1]!);
    expect(defaultText).toContain(MAIN_MEMORY);
    expect(defaultText).toContain(MAIN_MEMORY_INDEX);
    expect(defaultText).not.toContain(RECALLED_MEMORY);
    expect(semanticText).toContain(SEMANTIC_RECALL_MAIN_MEMORY);
    expect(semanticText).toContain(RECALLED_MEMORY);
    expect(semanticText).not.toContain(MAIN_MEMORY_INDEX);
    expect(semanticText).not.toContain(
      "After writing the file, add a one-line pointer in `MEMORY.md`",
    );
  });

  it("projects Main Memory and both Memory MCS surfaces into final streaming bodies", async () => {
    const capture = await startProviderBodyCapture();
    const adapter = createAdapter(capture.baseURL);

    await sendStreamingRequest(adapter, [
      systemMessage(MAIN_MEMORY, true),
      userMessage(MAIN_MEMORY_INDEX),
      userMessage("first request", true),
    ]);
    await sendStreamingRequest(adapter, [
      systemMessage(MAIN_MEMORY, true),
      userMessage("tool batch completed", true),
      systemMessage(RECALLED_MEMORY),
    ]);
    await sendStreamingRequest(adapter, [
      systemMessage(MAIN_MEMORY, true),
      userMessage("next request", true),
      systemMessage(MEMORY_UPDATE),
    ]);

    expect(capture.bodies).toHaveLength(3);
    expect(capture.bodies.map((body) => body.model)).toEqual([
      "claude-opus-4-8-cc",
      "claude-opus-4-8-cc",
      "claude-opus-4-8-cc",
    ]);
    expect(capture.bodies[0]!.system).toEqual([
      {
        cache_control: { type: "ephemeral" },
        text: MAIN_MEMORY,
        type: "text",
      },
    ]);
    expect(bodyMessages(capture.bodies[0]!)[0]).toEqual({
      content: [
        { text: MAIN_MEMORY_INDEX, type: "text" },
        {
          cache_control: { type: "ephemeral" },
          text: "first request",
          type: "text",
        },
      ],
      role: "user",
    });
    expect(bodyMessages(capture.bodies[1]!).at(-1)).toEqual({
      content: RECALLED_MEMORY,
      role: "system",
    });
    expect(bodyMessages(capture.bodies[2]!).at(-1)).toEqual({
      content: MEMORY_UPDATE,
      role: "system",
    });
    expect(bodyMessages(capture.bodies[1]!)[0]).toEqual({
      content: [
        {
          cache_control: { type: "ephemeral" },
          text: "tool batch completed",
          type: "text",
        },
      ],
      role: "user",
    });
    expect(capture.headers.map((headers) => headers["anthropic-beta"])).toEqual([
      "mid-conversation-system-2026-04-07",
      "mid-conversation-system-2026-04-07",
      "mid-conversation-system-2026-04-07",
    ]);
  });

  it("projects exact Extraction and Dream prompts with the permitted tool catalog", async () => {
    const capture = await startProviderBodyCapture();
    const adapter = createAdapter(capture.baseURL);

    await sendGenerateRequest(
      adapter,
      [
        systemMessage(MAIN_MEMORY, true),
        { content: "remember this durable preference", role: "user" },
        { content: "main answer", role: "assistant" },
        userMessage(EXTRACTION_PROMPT, true),
      ],
      MEMORY_TOOLS,
    );
    await sendGenerateRequest(
      adapter,
      [
        systemMessage(MAIN_MEMORY, true),
        { content: "completed session", role: "user" },
        userMessage(DREAM_PROMPT, true),
      ],
      MEMORY_TOOLS,
    );

    expect(capture.bodies).toHaveLength(2);
    expect(bodyMessages(capture.bodies[0]!).at(-1)).toEqual({
      content: [
        {
          cache_control: { type: "ephemeral" },
          text: EXTRACTION_PROMPT,
          type: "text",
        },
      ],
      role: "user",
    });
    expect(bodyMessages(capture.bodies[1]!).at(-1)).toEqual({
      content: [
        {
          text: "completed session",
          type: "text",
        },
        {
          cache_control: { type: "ephemeral" },
          text: DREAM_PROMPT,
          type: "text",
        },
      ],
      role: "user",
    });
    expect(capture.bodies.map(toolNames)).toEqual([
      ["Write", "Edit"],
      ["Write", "Edit"],
    ]);
  });

  it.each(["user", "project", "local"] as const)(
    "projects exact %s custom-agent Memory prompt and write tools into the final body",
    async (scope) => {
      const capture = await startProviderBodyCapture();
      const adapter = createAdapter(capture.baseURL);
      const rootDir = `/storage/agent-memory/${scope}`;
      const prompt = CUSTOM_AGENT_MEMORY.replaceAll("<MEMORY_ROOT>", rootDir).replaceAll(
        "<SCOPE_GUIDANCE>",
        CUSTOM_AGENT_SCOPE_GUIDANCE[scope],
      );

      await sendGenerateRequest(
        adapter,
        [
          systemMessage("You are a focused code reviewer.", true),
          systemMessage(`\n\n${prompt}`, true),
          { content: "review the change", role: "user" },
        ],
        MEMORY_TOOLS,
      );

      expect(capture.bodies).toHaveLength(1);
      expect(capture.bodies[0]!.system).toEqual([
        {
          cache_control: { type: "ephemeral" },
          text: "You are a focused code reviewer.",
          type: "text",
        },
        {
          cache_control: { type: "ephemeral" },
          text: `\n\n${prompt}`,
          type: "text",
        },
      ]);
      expect(systemTexts(capture.bodies[0]!)).not.toContain(MAIN_MEMORY);
      expect(toolNames(capture.bodies[0]!)).toEqual(["Write", "Edit"]);
    },
  );
});

function createAdapter(baseURL: string): AiSdkModelAdapter {
  return new AiSdkModelAdapter({
    registry: new TestProviderConfigFixture({
      env: {},
      providers: {
        anthropic: {
          apiKey: "provider-body-test-key",
          baseURL,
          headers: { "anthropic-beta": "mid-conversation-system-2026-04-07" },
          kind: "anthropic",
        },
      },
    }),
    retry: { maxAttempts: 1 },
  });
}

async function sendGenerateRequest(
  adapter: AiSdkModelAdapter,
  messages: ModelInputMessage[],
  tools?: ModelToolContract[],
): Promise<void> {
  try {
    await executeAdapterGenerateText(adapter, {
      providerId: "anthropic" as never,
      modelId: MODEL.modelId,
      messages,
      tools,
    });
  } catch {
    // 本地 capture endpoint 在记录最终 body 后固定返回 400；请求是否真正到达由调用方断言。
  }
}

async function sendStreamingRequest(
  adapter: AiSdkModelAdapter,
  messages: ModelInputMessage[],
): Promise<void> {
  try {
    for await (const _event of executeAdapterStreamText(adapter, {
      providerId: "anthropic" as never,
      modelId: MODEL.modelId,
      messages,
    })) {
      // Capture endpoint 不产生流事件。
    }
  } catch {
    // 本地 capture endpoint 在记录最终 body 后固定返回 400；请求是否真正到达由调用方断言。
  }
}

function systemMessage(content: string, cached = false): ModelInputMessage {
  return {
    ...(cached ? { cacheControl: { type: "ephemeral" as const } } : {}),
    content,
    role: "system",
  };
}

function userMessage(content: string, cached = false): ModelInputMessage {
  return {
    ...(cached ? { cacheControl: { type: "ephemeral" as const } } : {}),
    content,
    role: "user",
  };
}

function memoryFixture(filename: string, preserveFinalLf = false): string {
  const content = readFileSync(
    new URL(`../../core/tests/fixtures/memory/${filename}`, import.meta.url),
    "utf8",
  );
  return !preserveFinalLf && content.endsWith("\n") ? content.slice(0, -1) : content;
}

async function startProviderBodyCapture(): Promise<{
  baseURL: string;
  bodies: Record<string, unknown>[];
  headers: IncomingHttpHeaders[];
}> {
  const bodies: Record<string, unknown>[] = [];
  const headers: IncomingHttpHeaders[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk.toString();
    bodies.push(JSON.parse(body) as Record<string, unknown>);
    headers.push(request.headers);
    response.writeHead(400, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        error: { message: "request captured", type: "invalid_request_error" },
        type: "error",
      }),
    );
  });
  openServers.push(server);
  const baseURL = await listenServer(server);
  return { baseURL, bodies, headers };
}

function systemTexts(body: Record<string, unknown>): string[] {
  return contentTexts(body.system);
}

function bodyMessages(body: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(body.messages)) return [];
  return body.messages.flatMap((message) =>
    message && typeof message === "object" ? [message as Record<string, unknown>] : [],
  );
}

function requestBodyText(body: Record<string, unknown>): string {
  return [
    ...systemTexts(body),
    ...bodyMessages(body).flatMap((message) => contentTexts(message.content)),
  ].join("\n");
}

function contentTexts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    if (!block || typeof block !== "object") return [];
    const text = (block as Record<string, unknown>).text;
    return typeof text === "string" ? [text] : [];
  });
}

function toolNames(body: Record<string, unknown>): string[] {
  if (!Array.isArray(body.tools)) return [];
  return body.tools.flatMap((tool) => {
    if (!tool || typeof tool !== "object") return [];
    const name = (tool as Record<string, unknown>).name;
    return typeof name === "string" ? [name] : [];
  });
}

async function listenServer(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("capture server has no port");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
