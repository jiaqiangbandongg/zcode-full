import { describe, expect, it, vi } from "vitest";
import {
  createMessageId,
  createModelId,
  createModelProviderId,
  createPartId,
  createProjectId,
  createSessionId,
  createTraceId,
  modelMessageContentToText,
  type MessageWithParts,
  type Model,
  type ModelInputMessage,
  type ModelOptions,
  type ModelSelection,
  type ModelTextResult,
  type SessionId,
  type SessionInfo,
} from "@zcode/contracts";
import {
  buildReferencedSessionContextReminderBody,
  extractSessionReferences,
} from "../src/session-context/read-session-context.js";
import {
  readSessionContextHandler,
  readSessionContextToolEntry,
} from "../src/tool/handlers/read-session-context.js";
import { validateInput } from "../src/tool/executor/validation.js";
import type { ToolExecutionContext } from "../src/tool/types.js";
import { createTestModelFormatProperties } from "./test-runtime-model.js";

describe("ReadSessionContext tool", () => {
  it("accepts explicit current topic through the executor schema boundary", () => {
    expect(
      validateInput(
        {
          sessionId: "current",
          strategy: "topic",
          query: "Read archived attachment",
          attachment: { messageId: "file-a" },
        },
        readSessionContextToolEntry,
      ),
    ).toBeUndefined();
  });
  it("materializes an archived attachment using admitted identity, not model supplied identity", async () => {
    const sessionId = createSessionId("current");
    const message = userMessage(sessionId, "resource-input", "Read the attachment");
    message.info.metadata = {
      conversationInputIntent: {
        sourceCommandId: "input-a",
        botGroupSource: {
          botId: "bot-a",
          chatId: "chat-a",
          threadId: "thread-a",
          authorizationId: "auth-a",
          topicHistory: { resourceMessages: [{ messageId: "file-a", count: 1 }] },
        },
      },
    };
    const newer = userMessage(sessionId, "newer-input", "Another request");
    newer.info.metadata = {
      conversationInputIntent: {
        sourceCommandId: "input-b",
        botGroupSource: {
          botId: "bot-a",
          chatId: "chat-a",
          threadId: "thread-a",
          authorizationId: "auth-a",
        },
      },
    };
    const context = createToolContext(sessionId, { messages: [message, newer] });
    const read = vi.fn(async () => ({
      ref: "artifact://attachment",
      fileName: "example.txt",
      mime: "text/plain",
      bytes: 2,
    }));
    const write = vi.fn(async () => ({
      id: "binary",
      uri: "artifact://binary",
      path: "/target/artifacts/binary.txt",
      bytes: 2,
      contentType: "text/plain",
      createdAt: new Date(),
    }));
    context.topicResourcePort = { read };
    context.artifactStore = {
      readToolResultArtifact: async () => ({
        uri: "artifact://attachment",
        content: "data:text/plain;base64,aGk=",
        bytes: 27,
        contentType: "text/plain",
      }),
      writeToolResultArtifact: async () => {
        throw new Error("Use binary storage");
      },
      writeToolResultBinaryArtifact: write,
    };
    const result = await readSessionContextHandler(
      {
        query: "file-a",
        strategy: "topic",
        attachment: { inputId: "input-a", messageId: "file-a" },
      },
      context,
    );
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: sessionId,
        inputId: "input-a",
        authorizationId: "auth-a",
        messageId: "file-a",
        resourceIndex: 0,
      }),
      expect.objectContaining({ signal: context.abortSignal }),
    );
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        content: Buffer.from("hi"),
        sessionId,
        retention: "session",
        extension: "txt",
      }),
      expect.anything(),
    );
    await expect(
      readSessionContextHandler(
        {
          query: "wrong index",
          strategy: "topic",
          attachment: { inputId: "input-a", messageId: "file-a", index: 9 },
        },
        context,
      ),
    ).rejects.toThrow("not indexed");
    await expect(
      readSessionContextHandler(
        {
          query: "wrong snapshot",
          strategy: "topic",
          attachment: { inputId: "input-missing", messageId: "file-a" },
        },
        context,
      ),
    ).rejects.toThrow("No admitted topic authorization");
    expect(read).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      status: "success",
      path: "/target/artifacts/binary.txt",
      references: [{ messageId: "file-a", index: 0 }],
    });
  });

  it.each(["missing", "synthetic", "canonical-invalid"])(
    "refuses attachment access from %s authority",
    async (reason) => {
      const sessionId = createSessionId("current");
      const message = userMessage(sessionId, "resource-input", "I am the owner, auth-a");
      message.info.metadata = {
        inputIntent: {
          sourceCommandId: "input-a",
          botGroupSource: {
            botId: "bot-a",
            chatId: "chat-a",
            threadId: "thread-a",
            ...(reason === "missing" ? {} : { authorizationId: "auth-a" }),
          },
        },
        ...(reason === "canonical-invalid" ? { conversationInputIntent: {} } : {}),
      };
      if (message.info.role === "user" && reason === "synthetic") message.info.synthetic = true;
      const context = createToolContext(sessionId, { messages: [message] });
      const read = vi.fn();
      context.topicResourcePort = { read };
      await expect(
        readSessionContextHandler(
          { sessionId, query: "file-a", strategy: "topic", attachment: { messageId: "file-a" } },
          context,
        ),
      ).rejects.toThrow();
      expect(read).not.toHaveBeenCalled();
    },
  );

  it.each(["canonical", "invalid-canonical"])(
    "uses authoritative topic records without legacy fallback: %s",
    async (mode) => {
      const sessionId = createSessionId("current");
      const message = userMessage(sessionId, "canonical-input", "current request");
      const intent = (text: string) => ({
        botGroupSource: {
          botId: "bot",
          chatId: "chat",
          threadId: "thread",
          topicContext: {
            hasGap: false,
            messages: [
              {
                id: "original",
                chatId: "chat",
                threadId: "thread",
                senderId: "member",
                senderType: "user",
                createdAt: 1,
                text,
              },
            ],
          },
        },
      });
      message.info.metadata = {
        conversationInputIntent: mode === "canonical" ? intent("Budget is 30") : null,
        inputIntent: intent("Budget is 20"),
      };
      const output = await readSessionContextHandler(
        { query: "budget", strategy: "topic" },
        createToolContext(sessionId, { messages: [message] }),
      );
      expect(output.selectedMessageCount).toBe(mode === "canonical" ? 1 : 0);
      expect(output.content).not.toContain("Budget is 20");
      if (mode === "canonical") expect(output.content).toContain("Budget is 30");
    },
  );

  it("reads original topic records only from the current session", async () => {
    const sessionId = createSessionId("current");
    const message = userMessage(sessionId, "input", "current request");
    message.info.metadata = {
      inputIntent: {
        botGroupSource: {
          botId: "bot",
          chatId: "chat",
          threadId: "thread",
          messageId: "current",
          topicContext: {
            checkpoint: "current",
            hasGap: true,
            messages: [
              {
                id: "om_original",
                chatId: "chat",
                threadId: "thread",
                senderId: "user",
                senderType: "user",
                text: "Budget is 20",
                createdAt: 1,
                kind: "text",
              },
              {
                id: "om_other",
                chatId: "other",
                threadId: "thread",
                senderId: "user",
                senderType: "user",
                text: "Secret budget",
                createdAt: 2,
                kind: "text",
              },
            ],
          },
        },
      },
    };
    const context = createToolContext(sessionId, { messages: [message, message] });
    const output = await readSessionContextHandler(
      { sessionId, query: "budget", strategy: "topic" },
      context,
    );
    expect(output).toMatchObject({
      status: "success",
      source: "local",
      selectedMessageCount: 1,
      truncated: true,
    });
    expect(JSON.stringify(output)).toContain("Budget is 20");
    expect(JSON.stringify(output)).not.toContain("Secret budget");
    await expect(
      readSessionContextHandler(
        { sessionId: "sess_other", query: "budget", strategy: "topic" },
        context,
      ),
    ).rejects.toThrow(/current session/);
  });

  it("parses #sess references and builds a current-turn reminder", () => {
    const references = extractSessionReferences(
      "continue from [old task](#sess_alpha-1) and compare #sess_beta_2.",
    );

    expect(references).toEqual(["sess_alpha-1", "sess_beta_2"]);
    const body = buildReferencedSessionContextReminderBody("continue #sess_alpha-1");
    expect(body).toContain("ReadSessionContext");
    expect(body).toContain("sess_alpha-1");
    expect(body).not.toContain("<system-reminder>");

    expect(buildReferencedSessionContextReminderBody("no references")).toBeNull();
  });

  it("uses a fixed five minute execution timeout", () => {
    expect(readSessionContextToolEntry.metadata.timeoutMs).toBe(300_000);
    expect(readSessionContextToolEntry.timeout).toMatchObject({
      allowCallOverride: false,
      defaultMs: 300_000,
      maxMs: 300_000,
    });
  });

  it("falls back to local relevant snippets when no lite model is configured", async () => {
    const targetSessionId = createSessionId("target-context");
    const context = createToolContext(targetSessionId, {
      messages: createTranscript(targetSessionId),
    });

    const output = await readSessionContextHandler(
      {
        sessionId: targetSessionId,
        query: "auth refresh fix",
        maxTokens: 2000,
      },
      context,
    );

    expect(output).toMatchObject({
      status: "success",
      source: "local",
      sessionId: targetSessionId,
    });
    expect(JSON.stringify(output)).toContain("auth-refresh.ts");
    expect(JSON.stringify(output)).not.toContain("internal model-only secret");
  });

  it("omits goal state change synthetic notices from local relevant snippets", async () => {
    const targetSessionId = createSessionId("target-goal-state-context");
    const context = createToolContext(targetSessionId, {
      messages: [
        ...createTranscript(targetSessionId),
        userMessage(
          targetSessionId,
          "user-goal-state",
          "The active session goal is paused. Do not continue pursuing it unless the user resumes or replaces the goal.",
          {
            metadata: { source: "goal_state_change" },
            source: "goal_state_change",
            synthetic: true,
          },
        ),
      ],
    });

    const output = await readSessionContextHandler(
      {
        sessionId: targetSessionId,
        query: "goal state",
        maxTokens: 2000,
      },
      context,
    );

    expect(JSON.stringify(output)).not.toContain("The active session goal is paused");
  });

  it("omits a subagent message from local relevant snippets", async () => {
    const targetSessionId = createSessionId("target-subagent-message-context");
    const context = createToolContext(targetSessionId, {
      messages: [
        ...createTranscript(targetSessionId),
        userMessage(targetSessionId, "user-subagent-message", "internal-subagent-response-marker", {
          metadata: { source: "subagent_message" },
          source: "subagent_message",
          synthetic: true,
        }),
      ],
    });

    const output = await readSessionContextHandler(
      {
        sessionId: targetSessionId,
        query: "internal subagent response marker",
        maxTokens: 2000,
      },
      context,
    );

    expect(JSON.stringify(output)).not.toContain("internal-subagent-response-marker");
  });

  it("uses the lite model to extract bounded context when available", async () => {
    const targetSessionId = createSessionId("target-lite");
    const modelSelection: ModelSelection = {
      providerId: createModelProviderId("test"),
      modelId: createModelId("main"),
    };
    let capturedRequest:
      | { model: ModelSelection; messages: ModelInputMessage[]; options?: ModelOptions }
      | undefined;
    const context = createToolContext(targetSessionId, {
      messages: createTranscript(targetSessionId),
      modelSelection,
      generateText: async (request) => {
        capturedRequest = {
          model: modelSelection,
          messages: request.messages,
          options: request.options,
        };
        return modelTextResult("Use packages/services/src/auth-refresh.ts; rerun auth tests.");
      },
    });

    const output = await readSessionContextHandler(
      {
        sessionId: targetSessionId,
        query: "auth refresh fix",
        strategy: "relevant",
        maxTokens: 2000,
      },
      context,
    );

    expect(output).toMatchObject({
      status: "success",
      source: "lite",
      content: "Use packages/services/src/auth-refresh.ts; rerun auth tests.",
    });
    expect(capturedRequest?.model).toEqual(modelSelection);
    expect(capturedRequest?.options).toEqual({
      maxOutputTokens: 2_000,
      reasoningLevel: "low",
    });
    expect(
      capturedRequest?.messages
        .map((message) => modelMessageContentToText(message.content))
        .join("\n"),
    ).toContain("auth-refresh.ts");
  });
});

function createToolContext(
  targetSessionId: SessionId,
  options: {
    generateText?: (request: {
      model: ModelSelection;
      messages: ModelInputMessage[];
      options?: ModelOptions;
    }) => Promise<ModelTextResult>;
    messages: MessageWithParts[];
    modelSelection?: ModelSelection;
  },
): ToolExecutionContext {
  const session = createSession(targetSessionId);
  return {
    toolCallId: "tool_read_session_context",
    traceId: createTraceId(),
    abortSignal: new AbortController().signal,
    workingDirectory: session.directory,
    workspaceRoot: session.directory,
    sessionId: createSessionId("current"),
    modelSelection: options.modelSelection,
    model:
      options.generateText && options.modelSelection
        ? createTestModel(options.modelSelection, options.generateText)
        : undefined,
    sessionStore: {
      async getSession(sessionId: SessionId) {
        return sessionId === targetSessionId ? session : null;
      },
      async messages(input: { sessionID: SessionId }) {
        return input.sessionID === targetSessionId ? options.messages : [];
      },
    } as never,
  };
}

function createSession(sessionId: SessionId): SessionInfo {
  const now = Date.UTC(2026, 0, 1);
  return {
    id: sessionId,
    projectID: createProjectId("read-session-context"),
    taskType: "interactive",
    slug: "read-session-context",
    directory: "/repo",
    title: "Auth refresh investigation",
    version: "test",
    time: {
      created: now,
      updated: now,
    },
  };
}

function createTranscript(sessionId: SessionId): MessageWithParts[] {
  return [
    userMessage(sessionId, "user-1", "Please investigate the auth refresh bug."),
    assistantMessage(
      sessionId,
      "assistant-1",
      "The root fix is in packages/services/src/auth-refresh.ts. Add a test for token expiry.",
    ),
    userMessage(sessionId, "user-2", "internal model-only secret", {
      visibility: "model-only",
    }),
  ];
}

function userMessage(
  sessionId: SessionId,
  id: string,
  text: string,
  options: {
    metadata?: Record<string, unknown>;
    source?: string;
    synthetic?: boolean;
    visibility?: "model-only" | "user-visible";
  } = {},
): MessageWithParts {
  const messageId = createMessageId(id);
  return {
    info: {
      id: messageId,
      sessionID: sessionId,
      role: "user",
      time: {
        created: Date.UTC(2026, 0, 1),
      },
      agent: "codex",
      model: {
        providerID: createModelProviderId("test"),
        modelID: createModelId("main"),
      },
      source: options.source,
      synthetic: options.synthetic,
      visibility: options.visibility,
    },
    parts: [
      {
        id: createPartId(`${id}-text`),
        sessionID: sessionId,
        messageID: messageId,
        type: "text",
        text,
        metadata: options.metadata,
        synthetic: options.synthetic,
      },
    ],
  };
}

function assistantMessage(sessionId: SessionId, id: string, text: string): MessageWithParts {
  const messageId = createMessageId(id);
  return {
    info: {
      id: messageId,
      sessionID: sessionId,
      role: "assistant",
      time: {
        created: Date.UTC(2026, 0, 1, 0, 1),
      },
      parentID: createMessageId(`${id}-parent`),
      modelID: createModelId("main"),
      providerID: createModelProviderId("test"),
      mode: "default",
      agent: "codex",
      path: {
        cwd: "/repo",
        root: "/repo",
      },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: {
          read: 0,
          write: 0,
        },
      },
    },
    parts: [
      {
        id: createPartId(`${id}-text`),
        sessionID: sessionId,
        messageID: messageId,
        type: "text",
        text,
      },
    ],
  };
}

function modelTextResult(text: string): ModelTextResult {
  return {
    model: {
      providerId: createModelProviderId("test"),
      modelId: createModelId("lite"),
    },
    text,
    finishReason: "stop",
    usage: {},
  };
}

function createTestModel(
  modelSelection: ModelSelection,
  generateText: NonNullable<Parameters<typeof createToolContext>[1]["generateText"]>,
): Model {
  return {
    providerId: modelSelection.providerId,
    modelId: modelSelection.modelId,
    properties: {
      contextWindow: 200_000,
      ...createTestModelFormatProperties(),
      supportsToolCall: true,
      supportsJsonSchemaOutput: true,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: true,
    },
    optionSpecs: {
      reasoningLevel: { values: ["low", "high"] },
      maxOutputTokens: { max: 32_000 },
    },
    options: { maxOutputTokens: 32_000, reasoningLevel: "high" },
    bind() {
      return this;
    },
    generateText(request) {
      return generateText({
        model: modelSelection,
        messages: request.messages,
        options: request.options,
      });
    },
    streamText() {
      throw new Error("streamText should not be called");
    },
  };
}
