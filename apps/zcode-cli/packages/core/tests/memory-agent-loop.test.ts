import { describe, expect, it, vi } from "vitest";
import {
  createModelId,
  createModelProviderId,
  type Model,
  type ModelInputMessage,
  type ModelRequest,
  type ModelResult,
  type ModelToolContract,
} from "@zcode/contracts";

import {
  evaluateMemoryAgentToolPolicy,
  runMemoryAgentLoop,
  type MemoryAgentModelRequest,
} from "../src/memory/memory-agent-loop.js";
import { DEFAULT_MODEL_REQUEST_MEDIA_BUDGET_BYTES } from "../src/runtime/helpers/media-budget.js";
import type { ToolExecutionResult } from "../src/tool/types.js";
import { createTestInputFormat } from "./test-runtime-model.js";

const modelSelection = {
  providerId: createModelProviderId("test"),
  modelId: createModelId("memory-agent"),
};
const memoryRoot = "/workspace/.memory";

describe("runMemoryAgentLoop", () => {
  it("preserves the frozen provider context and real tool catalog on every model turn", async () => {
    const initialMessages = Object.freeze([
      Object.freeze({ role: "system", content: "full system" }),
      Object.freeze({ role: "user", content: "full conversation" }),
      Object.freeze({ role: "user", content: "extract now" }),
    ]) satisfies readonly ModelInputMessage[];
    const tools = Object.freeze([
      tool("Read", true, "none"),
      tool("Write", false, "workspace"),
      tool("Agent", false, "session"),
    ]) satisfies readonly ModelToolContract[];
    const requests: MemoryAgentModelRequest[] = [];
    const executeTool = vi.fn(async (call) => executionResult(call.id, call.name, "written"));
    const model = generateOnlyModel(async (request) => {
      requests.push(request as MemoryAgentModelRequest);
      if (requests.length < 5) {
        return modelResult({
          text: `turn ${requests.length}`,
          toolCalls: [{ id: `read-${requests.length}`, name: "Read", input: {} }],
        });
      }
      return modelResult({
        text: "last turn",
        toolCalls: [
          {
            id: "write-last",
            name: "Write",
            input: { file_path: `${memoryRoot}/fact.md`, content: "fact" },
          },
        ],
      });
    });

    const result = await runMemoryAgentLoop({
      abortSignal: new AbortController().signal,
      executeTool,
      maxTurns: 5,
      messages: initialMessages,
      model,
      rootDir: memoryRoot,
      tools,
      workingDirectory: "/workspace",
      workspaceRoot: "/workspace",
    });

    expect(requests).toHaveLength(5);
    expect(executeTool).toHaveBeenCalledTimes(5);
    expect(executeTool).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "write-last", name: "Write" }),
      expect.objectContaining({ abortSignal: expect.any(AbortSignal) }),
    );
    expect(requests[0]?.messages).toEqual(initialMessages);
    expect(requests.every((request) => request.tools === tools)).toBe(true);
    expect(requests.every((request) => request.options?.reasoningLevel === "low")).toBe(true);
    expect(requests.every((request) => request.options?.maxOutputTokens === 5_000)).toBe(true);
    expect(requests[1]?.messages.slice(-2)).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: "turn 1",
        toolCalls: [{ id: "read-1", name: "Read", input: {} }],
      }),
      expect.objectContaining({
        role: "tool",
        content: "written",
        toolCallId: "read-1",
        toolName: "Read",
        isError: false,
      }),
    ]);
    expect(result.turns).toBe(5);
    expect(result.messages.slice(-2)).toEqual([
      expect.objectContaining({ role: "assistant", content: "last turn" }),
      expect.objectContaining({ role: "tool", toolCallId: "write-last", isError: false }),
    ]);
    expect(initialMessages).toHaveLength(3);
  });

  it("applies media capability and budget projection on every model turn", async () => {
    const unsupportedVideo = {
      type: "video" as const,
      mediaType: "video/mp4",
      dataUrl: "data:video/mp4;base64,dmlkZW8=",
    };
    const sharedImageDataUrl = `data:image/png;base64,${"A".repeat(5 * 1024 * 1024)}`;
    const retainedImageCount = Math.floor(
      DEFAULT_MODEL_REQUEST_MEDIA_BUDGET_BYTES / Buffer.byteLength(sharedImageDataUrl, "utf8"),
    );
    const historicalImage = {
      type: "image" as const,
      mediaType: "image/png",
      dataUrl: sharedImageDataUrl,
    };
    const requests: ModelRequest[] = [];
    const executeTool = vi.fn(async (call) => ({
      ...executionResult(call.id, call.name, "read media"),
      modelContent: [unsupportedVideo, historicalImage],
    }));
    const model = generateOnlyModel(
      async (request) => {
        requests.push(request);
        return requests.length === 1
          ? modelResult({
              toolCalls: [
                { id: "read-media-1", name: "Read", input: {} },
                { id: "read-media-2", name: "Read", input: {} },
              ],
            })
          : modelResult({ text: "done" });
      },
      { inputFormat: createTestInputFormat({ supportsVideo: false }) },
    );

    await runMemoryAgentLoop({
      executeTool,
      maxTurns: 2,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "historical media" },
            unsupportedVideo,
            ...Array.from({ length: retainedImageCount + 2 }, () => historicalImage),
          ],
        },
        { role: "user", content: "extract memory" },
      ],
      model,
      rootDir: memoryRoot,
      tools: [tool("Read", true, "none")],
      workingDirectory: "/workspace",
      workspaceRoot: "/workspace",
    });

    expect(requests).toHaveLength(2);
    for (const request of requests) {
      const blocks = request.messages.flatMap((message) =>
        Array.isArray(message.content) ? message.content : [],
      );
      const text = blocks
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      expect(blocks.filter((block) => block.type === "video")).toHaveLength(0);
      expect(blocks.filter((block) => block.type === "image")).toHaveLength(retainedImageCount);
      expect(text).toContain("does not support video input");
      expect(text).toContain("Media omitted from provider request");
    }
  });

  it("returns the exact provider-visible denial text without invoking the executor", async () => {
    const executeTool = vi.fn();
    const requests: ModelRequest[] = [];
    const model = generateOnlyModel(async (request) => {
      requests.push(request);
      if (requests.length === 1) {
        return modelResult({
          toolCalls: [
            { id: "network", name: "WebFetch", input: { url: "https://example.com" } },
            { id: "bash-write", name: "Bash", input: { command: "touch /workspace/file" } },
          ],
        });
      }
      return modelResult({ text: "done" });
    });

    const result = await runMemoryAgentLoop({
      executeTool,
      maxTurns: 2,
      messages: [{ role: "user", content: "extract" }],
      model,
      rootDir: memoryRoot,
      tools: [tool("WebFetch", true, "network"), tool("Bash", false, "workspace")],
      workingDirectory: "/workspace",
      workspaceRoot: "/workspace",
    });

    expect(executeTool).not.toHaveBeenCalled();
    const deniedToolMessages = [
      {
        content:
          "only Read, Grep, Glob, read-only Bash, and Edit/Write within /workspace/.memory are allowed",
        role: "tool",
        toolCallId: "network",
        toolName: "WebFetch",
        isError: true,
      },
      {
        content:
          "Only read-only shell commands and rm with all paths inside /workspace/.memory are permitted in this context (ls, find, grep, cat, stat, wc, head, tail, and similar)",
        role: "tool",
        toolCallId: "bash-write",
        toolName: "Bash",
        isError: true,
      },
    ];
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages.slice(-2)).toEqual(deniedToolMessages);
    expect(result.messages.slice(-3, -1)).toEqual(deniedToolMessages);
  });

  it("returns the catalog-miss result before applying the Memory tool policy", async () => {
    const executeTool = vi.fn();
    const requests: ModelRequest[] = [];
    const model = generateOnlyModel(async (request) => {
      requests.push(request);
      if (requests.length === 1) {
        return modelResult({
          toolCalls: [
            { id: "empty-name", name: "", input: {} },
            { id: "unknown-name", name: "Unknown", input: {} },
          ],
        });
      }
      return modelResult({ text: "done" });
    });

    await runMemoryAgentLoop({
      executeTool,
      maxTurns: 2,
      messages: [{ role: "user", content: "extract" }],
      model,
      rootDir: memoryRoot,
      tools: [tool("Read", true, "none")],
      workingDirectory: "/workspace",
      workspaceRoot: "/workspace",
    });

    expect(executeTool).not.toHaveBeenCalled();
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages.slice(-2)).toEqual([
      {
        content: "<tool_use_error>Error: No such tool available: </tool_use_error>",
        role: "tool",
        toolCallId: "empty-name",
        toolName: "",
        isError: true,
      },
      {
        content: "<tool_use_error>Error: No such tool available: Unknown</tool_use_error>",
        role: "tool",
        toolCallId: "unknown-name",
        toolName: "Unknown",
        isError: true,
      },
    ]);
  });

  it("executes tool calls returned by the fiftieth Dream turn", async () => {
    let requestCount = 0;
    const executeTool = vi.fn(async (call) => executionResult(call.id, call.name, "done"));
    const model = generateOnlyModel(async () => {
      requestCount += 1;
      return modelResult({
        toolCalls: [
          requestCount === 50
            ? {
                id: "write-fiftieth",
                name: "Write",
                input: { file_path: `${memoryRoot}/fact.md`, content: "fact" },
              }
            : { id: `read-${requestCount}`, name: "Read", input: {} },
        ],
      });
    });

    const result = await runMemoryAgentLoop({
      executeTool,
      maxTurns: 50,
      messages: [{ role: "user", content: "dream" }],
      model,
      rootDir: memoryRoot,
      tools: [tool("Read", true, "none"), tool("Write", false, "workspace")],
      workingDirectory: "/workspace",
      workspaceRoot: "/workspace",
    });

    expect(result.turns).toBe(50);
    expect(executeTool).toHaveBeenCalledTimes(50);
    expect(executeTool).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "write-fiftieth", name: "Write" }),
      expect.any(Object),
    );
  });
});

describe("evaluateMemoryAgentToolPolicy", () => {
  const registeredTools = [
    tool("Read", true, "none"),
    tool("Grep", true, "none"),
    tool("Bash", false, "workspace"),
    tool("Write", false, "workspace"),
    tool("Edit", false, "workspace"),
    tool("Agent", false, "session"),
    tool("WebFetch", true, "network"),
    tool("mcp__server__lookup", true, "network"),
    tool("OtherReadOnly", true, "none"),
  ] as const;

  it.each([
    ["registered read-only", "Read", {}],
    ["read-only Bash", "Bash", { command: "head -n 5 /workspace/notes.txt" }],
    ["read-only Bash with safe environment", "Bash", { command: "LANG=C head /workspace/file" }],
    ["read-only Bash with input redirect", "Bash", { command: "head < /workspace/file" }],
    [
      "read-only Bash redirected to /dev/null",
      "Bash",
      {
        command: "head /workspace/file > /dev/null",
      },
    ],
    [
      "read-only background Bash",
      "Bash",
      {
        command: "head /workspace/file",
        run_in_background: true,
      },
    ],
    ["Memory Write", "Write", { file_path: `${memoryRoot}/fact.md`, content: "fact" }],
    [
      "Memory Edit",
      "Edit",
      { file_path: `${memoryRoot}/nested/fact.md`, old_string: "a", new_string: "b" },
    ],
    ["narrow Bash removal", "Bash", { command: `rm -f ${memoryRoot}/old.md` }],
  ])("allows %s", (_label, name, input) => {
    expect(decide(name, input, registeredTools)).toMatchObject({ allowed: true });
  });

  it("does not let static metadata bypass the explicit shell, Agent, or MCP boundaries", () => {
    expect(
      decide("Bash", { command: "touch /workspace/file" }, [tool("Bash", true, "none")]),
    ).toMatchObject({ allowed: false });
    expect(decide("Agent", {}, [tool("Agent", true, "none")])).toMatchObject({ allowed: false });
    expect(
      decide("mcp__server__lookup", {}, [tool("mcp__server__lookup", true, "none")]),
    ).toMatchObject({ allowed: false });
  });

  it.each([
    ".git",
    "hooks",
    ".husky",
    ".githooks",
    "node_modules",
    ".vscode",
    ".idea",
    "head",
    "config",
    "objects",
    "refs",
    ".claude",
    "skills",
    "commands",
    "agents",
    ".cargo",
    ".devcontainer",
    ".yarn",
    ".mvn",
  ])("denies Memory Write/Edit in the sensitive %s path segment", (segment) => {
    const filePath = `${memoryRoot}/${segment}/fact.md`;
    expect(decide("Write", { file_path: filePath }, registeredTools)).toMatchObject({
      allowed: false,
    });
    expect(decide("Edit", { file_path: filePath }, registeredTools)).toMatchObject({
      allowed: false,
    });
  });

  it("uses the foreground sensitive-segment normalization without broadening it", () => {
    for (const segment of [".GIT", ".git.", ".git ", ".g\u200cit", ".git:stream"]) {
      expect(
        decide("Write", { file_path: `${memoryRoot}/${segment}/fact.md` }, registeredTools),
      ).toMatchObject({ allowed: false });
    }
    expect(
      decide("Write", { file_path: `${memoryRoot}/.git-notes/fact.md` }, registeredTools),
    ).toMatchObject({ allowed: true });
  });

  it("keeps the narrow Markdown rm policy unchanged for sensitive path segments", () => {
    expect(
      decide("Bash", { command: `rm -f ${memoryRoot}/.git/fact.md` }, registeredTools),
    ).toMatchObject({ allowed: true });
  });

  it.each([
    ["unregistered", "Unknown", {}],
    ["Agent", "Agent", {}],
    ["network tool", "WebFetch", { url: "https://example.com" }],
    ["MCP tool", "mcp__server__lookup", {}],
    ["unlisted read-only tool", "OtherReadOnly", {}],
    ["outside Write", "Write", { file_path: "/workspace/outside.md", content: "x" }],
    ["uppercase extension", "Write", { file_path: `${memoryRoot}/fact.MD`, content: "x" }],
    ["write-capable Bash", "Bash", { command: "touch /workspace/file" }],
    ["recursive removal", "Bash", { command: `rm -rf ${memoryRoot}/old.md` }],
    ["glob removal", "Bash", { command: `rm ${memoryRoot}/*.md` }],
    ["write redirect", "Bash", { command: "head /workspace/file > /workspace/copy" }],
    ["unsafe environment prefix", "Bash", { command: "PATH=/tmp head /workspace/file" }],
  ])("denies %s", (_label, name, input) => {
    expect(decide(name, input, registeredTools)).toMatchObject({ allowed: false });
  });
});

function decide(name: string, input: unknown, tools: readonly ModelToolContract[]) {
  return evaluateMemoryAgentToolPolicy({
    rootDir: memoryRoot,
    toolCall: { id: "call", name, input },
    tools,
    workingDirectory: "/workspace",
    workspaceRoot: "/workspace",
  });
}

function tool(
  name: string,
  readOnly: boolean,
  sideEffectScope: ModelToolContract["sideEffectScope"],
): ModelToolContract {
  return {
    name,
    inputSchema: { type: "object" },
    readOnly,
    sideEffectScope,
  };
}

function generateOnlyModel(
  generateText: (request: ModelRequest) => Promise<ModelResult>,
  properties: Partial<Model["properties"]> = {},
): Model {
  return {
    ...modelSelection,
    properties: {
      requiresMfjsToolSchema: false,
      contextWindow: 200_000,
      inputFormat: createTestInputFormat(),
      outputFormat: { supportsText: true },
      supportsToolCall: true,
      supportsJsonSchemaOutput: true,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: true,
      ...properties,
    },
    optionSpecs: {
      reasoningLevel: { values: ["low", "high"] },
      maxOutputTokens: { max: 32_000 },
    },
    options: { maxOutputTokens: 32_000, reasoningLevel: "high" },
    bind() {
      return this;
    },
    generateText,
    streamText() {
      throw new Error("memory agent loop must not stream");
    },
  };
}

function modelResult(
  input: Pick<Partial<ModelResult>, "reasoning" | "text" | "toolCalls">,
): ModelResult {
  return {
    finishReason: input.toolCalls?.length ? "tool_calls" : "stop",
    model: modelSelection,
    text: input.text ?? "",
    toolCalls: input.toolCalls,
    reasoning: input.reasoning,
    usage: {},
  };
}

function executionResult(
  toolCallId: string,
  toolName: string,
  output: unknown,
): ToolExecutionResult {
  const now = new Date();
  return {
    completedAt: now,
    durationMs: 0,
    output,
    startedAt: now,
    success: true,
    toolCallId,
    toolName,
  };
}
