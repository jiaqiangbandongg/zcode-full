import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Readable, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createNodeLoggerFactory } from "@zcode/adapters/logging";
import {
  createInMemorySessionEventStore,
  createNodeToolArtifactStore,
  createSqliteSessionStore,
} from "@zcode/adapters/storage";
import { createNodeWorkflowStore } from "@zcode/adapters/workflow";
import { DEFAULT_EXPERT_WORKFLOW_STRATEGY } from "@zcode/core";
import { createNodeProviderRuntimePathEnv } from "@zcode/provider-node";
import {
  LogLevel,
  SESSION_ENTRY_BASH_SHELL_SELECTION,
  SESSION_ENTRY_MODEL_SELECTION,
  type LogContext,
  type Logger,
  type LoggerFactory,
  SessionEventType,
  createMessageId,
  createPartId,
  createProjectId,
  createSessionId,
  type EnvInfo,
  type ExecutionPort,
  type TargetChangedPayload,
  type WorkflowRunSnapshot,
} from "@zcode/contracts";
import { resolveLatestSession, runZCodeProtocolAgent } from "../src/index.js";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";
import { synthesizeEventsFromMessages } from "../src/zcode-protocol-v4/transcript-hydration.js";
import {
  createRegistryBackedTestApp as createZCodeApp,
  createTestProviderRegistry,
} from "./helpers/registry-backed-test-app.js";

describe("session persistence", () => {
  it("persists Highspeed metadata in the user message data", async () => {
    const store = createSqliteSessionStore({ dbPath: ":memory:" });
    const sessionId = createSessionId("highspeed-message-metadata");

    try {
      const app = await createZCodeApp({
        env: {},
        modelExecutor: {
          async generateText() {
            return {
              finishReason: "stop",
              text: "accelerated answer",
              usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
            };
          },
        } as never,
        runtimeConfig: { workingDirectory: process.cwd() },
        sessionId,
        sessionStore: store,
        skipUserConfig: true,
      });
      const highspeed = {
        schemaVersion: 1 as const,
        cardId: "hsc-1",
        taskId: sessionId,
        provider: "zai",
        model: "glm-5",
        issuedAt: 1_000,
        expiresAt: 10_000,
      };

      await app.submitPrompt("hello", {
        intent: {
          sourceCommandId: "command-highspeed-1",
          queueItemId: "queue-highspeed-1",
          clientId: "desktop-test",
          kind: "sendText",
          text: "hello",
          admissionSeq: 1,
          admittedAt: 1,
          requestedDelivery: "startNow",
          admittedDelivery: "startNow",
          highspeed,
        } as never,
      });

      const messages = await store.messages({ sessionID: sessionId });
      const userMessage = messages.find((message) => message.info.role === "user");
      expect(userMessage?.info.metadata?.highspeed).toEqual(highspeed);
    } finally {
      store.close();
    }
  });

  it("primes image and cold-rebuilds image and video paths from durable artifacts", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-prompt-image-cache-"));
    const artifactRootDir = join(tempRoot, "artifacts");
    const imageCacheRootDir = join(tempRoot, "image-cache");
    const videoCacheRootDir = join(tempRoot, "video-cache");
    const sessionStore = createSqliteSessionStore({ dbPath: ":memory:" });
    const artifactStore = createNodeToolArtifactStore({
      imageCacheRootDir,
      rootDir: artifactRootDir,
      videoCacheRootDir,
    });
    const primeSpy = vi.spyOn(artifactStore, "primeMediaAttachmentPath");

    try {
      const app = await createZCodeApp({
        artifactStore,
        env: {},
        runtimeConfig: { workingDirectory: process.cwd() },
        sessionStore,
        skipUserConfig: true,
      });
      const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);

      const imageAttachment = await app.writePromptAttachment({
        bytes,
        fileName: "pasted.png",
        mime: "image/png",
      });
      const videoBytes = Uint8Array.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
      const videoAttachment = await app.writePromptAttachment({
        bytes: videoBytes,
        fileName: "clip.mp4",
        mime: "video/mp4",
      });

      expect(imageAttachment.ref).toMatch(/^zcode-artifact:\/\//u);
      expect(videoAttachment.ref).toMatch(/^zcode-artifact:\/\//u);
      await vi.waitFor(() => expect(primeSpy).toHaveBeenCalledTimes(2));
      expect(primeSpy).toHaveBeenNthCalledWith(1, {
        bytes,
        mediaType: "image/png",
        uri: imageAttachment.ref,
      });
      expect(primeSpy).toHaveBeenNthCalledWith(2, {
        bytes: videoBytes,
        mediaType: "video/mp4",
        uri: videoAttachment.ref,
      });
      const primed = await artifactStore.ensureMediaAttachmentPath!({
        mediaType: "image/png",
        uri: imageAttachment.ref,
      });
      if (primed.status !== "ready") throw new Error("expected primed PNG image path");
      const videoPath = await artifactStore.ensureMediaAttachmentPath!({
        mediaType: "video/mp4",
        uri: videoAttachment.ref,
      });
      if (videoPath.status !== "ready") throw new Error("expected MP4 video path");
      await unlink(primed.path);
      await unlink(videoPath.path);
      await app.close?.();

      const coldStore = createNodeToolArtifactStore({
        imageCacheRootDir,
        rootDir: artifactRootDir,
        videoCacheRootDir,
      });
      const rebuilt = await coldStore.ensureMediaAttachmentPath!({
        mediaType: "image/png",
        uri: imageAttachment.ref,
      });
      if (rebuilt.status !== "ready") throw new Error("expected rebuilt PNG image path");
      expect(rebuilt.path).toBe(primed.path);
      await expect(readFile(rebuilt.path)).resolves.toEqual(Buffer.from(bytes));
      const rebuiltVideo = await coldStore.ensureMediaAttachmentPath!({
        mediaType: "video/mp4",
        uri: videoAttachment.ref,
      });
      if (rebuiltVideo.status !== "ready") throw new Error("expected rebuilt MP4 video path");
      expect(rebuiltVideo.path).toBe(videoPath.path);
      await expect(readFile(rebuiltVideo.path)).resolves.toEqual(Buffer.from(videoBytes));
    } finally {
      sessionStore.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("previews the exact persisted media artifact before a mutable original path", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-sent-media-preview-"));
    const originalPath = join(tempRoot, "same.mov");
    const artifactStore = createNodeToolArtifactStore({
      imageCacheRootDir: join(tempRoot, "image-cache"),
      rootDir: join(tempRoot, "artifacts"),
      videoCacheRootDir: join(tempRoot, "video-cache"),
    });
    const store = createSqliteSessionStore({ dbPath: ":memory:" });
    const sessionId = createSessionId("sent-media-preview");
    const messageId = createMessageId();
    const persistedBytes = Uint8Array.from([1, 2, 3, 4]);
    const changedOriginalBytes = Uint8Array.from([9, 8, 7, 6]);
    let app: Awaited<ReturnType<typeof createZCodeApp>> | undefined;

    try {
      await store.createSession({
        id: sessionId,
        projectID: createProjectId("sent-media-preview-project"),
        slug: "sent-media-preview",
        directory: tempRoot,
        title: "Sent media preview",
        version: "test",
      });
      await writeFile(originalPath, changedOriginalBytes);
      app = await createZCodeApp({
        artifactStore,
        bootstrapModelConfig: {
          main: {
            apiKeyRequired: false,
            baseURL: "https://api.example.test/anthropic",
            kind: "anthropic",
            model: "agent-model",
            provider: "custom-provider",
          },
        },
        env: {},
        runtimeConfig: { workingDirectory: tempRoot },
        sessionId,
        sessionStore: store,
        skipUserConfig: true,
      });
      const artifact = await app.writePromptAttachment({
        bytes: persistedBytes,
        fileName: "same.mov",
        mime: "video/quicktime",
      });
      await store.saveMessage({
        id: messageId,
        sessionID: sessionId,
        role: "user",
        time: { created: Date.now() },
        agent: "zcode-agent",
        model: { providerID: "custom-provider", modelID: "agent-model" },
      });
      await store.savePart({
        id: createPartId(),
        sessionID: sessionId,
        messageID: messageId,
        type: "file",
        filename: "same.mov",
        mime: "video/quicktime",
        url: artifact.ref,
        source: {
          type: "file",
          path: originalPath,
          text: { value: originalPath, start: 0, end: originalPath.length },
        },
        metadata: {
          artifactUri: artifact.ref,
          originalUrl: originalPath,
          recoverability: "provider_ready",
          storageKind: "artifact",
        },
      });
      const messagesSpy = vi.spyOn(store, "messages");

      const previewSource = await app.resolvePromptAttachmentPreviewSource({
        ref: originalPath,
        mime: "video/quicktime",
        messageId,
        attachmentIndex: 0,
      });
      expect(previewSource).toMatchObject({
        kind: "local_path",
        mediaType: "video/quicktime",
      });
      if (previewSource.kind !== "local_path") throw new Error("expected local artifact path");
      expect(previewSource.path).toContain(join(tempRoot, "video-cache"));
      await expect(readFile(previewSource.path)).resolves.toEqual(Buffer.from(persistedBytes));

      await expect(
        app.readPromptAttachment({
          ref: originalPath,
          mime: "video/quicktime",
          maxBytes: 1024,
          messageId,
          attachmentIndex: 0,
        }),
      ).resolves.toEqual({
        bytes: Buffer.from(persistedBytes),
        mediaType: "video/quicktime",
      });
      expect(messagesSpy).not.toHaveBeenCalled();
      await expect(
        app.readPromptAttachment({
          ref: originalPath,
          mime: "video/quicktime",
          maxBytes: 1024,
        }),
      ).resolves.toEqual({
        bytes: Buffer.from(changedOriginalBytes),
        mediaType: "video/quicktime",
      });

      const ensurePath = vi
        .spyOn(artifactStore, "ensureMediaAttachmentPath")
        .mockRejectedValueOnce(new Error("derived path unavailable"));
      await expect(
        app.resolvePromptAttachmentPreviewSource({
          ref: originalPath,
          mime: "video/quicktime",
          messageId,
          attachmentIndex: 0,
        }),
      ).resolves.toEqual({ kind: "chunked" });
      expect(ensurePath).toHaveBeenCalledWith({
        mediaType: "video/quicktime",
        uri: artifact.ref,
      });
    } finally {
      await app?.close?.();
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("returns an authorized metadata-only local video path without reading the file", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-sent-local-ref-preview-"));
    const originalPath = join(tempRoot, "oversized.mp4");
    const store = createSqliteSessionStore({ dbPath: ":memory:" });
    const sessionId = createSessionId("sent-local-ref-preview");
    const messageId = createMessageId();
    let app: Awaited<ReturnType<typeof createZCodeApp>> | undefined;

    try {
      await store.createSession({
        id: sessionId,
        projectID: createProjectId("sent-local-ref-preview-project"),
        slug: "sent-local-ref-preview",
        directory: tempRoot,
        title: "Sent local ref preview",
        version: "test",
      });
      app = await createZCodeApp({
        bootstrapModelConfig: {
          main: {
            apiKeyRequired: false,
            baseURL: "https://api.example.test/anthropic",
            kind: "anthropic",
            model: "agent-model",
            provider: "custom-provider",
          },
        },
        env: {},
        runtimeConfig: { workingDirectory: tempRoot },
        sessionId,
        sessionStore: store,
        skipUserConfig: true,
      });
      await store.saveMessage({
        id: messageId,
        sessionID: sessionId,
        role: "user",
        time: { created: Date.now() },
        agent: "zcode-agent",
        model: { providerID: "custom-provider", modelID: "agent-model" },
      });
      await store.savePart({
        id: createPartId(),
        sessionID: sessionId,
        messageID: messageId,
        type: "file",
        filename: "oversized.mp4",
        mime: "video/mp4",
        url: originalPath,
        metadata: {
          originalUrl: originalPath,
          recoverability: "metadata_only",
          sizeBytes: 100 * 1024 * 1024 + 1,
          storageKind: "local_ref",
        },
      });

      await expect(
        app.resolvePromptAttachmentPreviewSource({
          ref: originalPath,
          mime: "video/mp4",
          messageId,
          attachmentIndex: 0,
        }),
      ).resolves.toEqual({
        kind: "local_path",
        path: originalPath,
        mediaType: "video/mp4",
      });
    } finally {
      await app?.close?.();
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("filters skills disabled through skills path config during app startup", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-bootstrap-skill-disable-"));
    const configPath = join(tempRoot, "config.json");
    const enabledSkillPath = join(
      tempRoot,
      ".zcode",
      "skills",
      "enabled-runtime-skill",
      "SKILL.md",
    );
    const disabledSkillPath = join(
      tempRoot,
      ".zcode",
      "skills",
      "disabled-runtime-skill",
      "SKILL.md",
    );
    const store = createSqliteSessionStore({ dbPath: ":memory:" });
    const requests: Array<Array<{ content: unknown; role: string }>> = [];
    let app: Awaited<ReturnType<typeof createZCodeApp>> | undefined;

    try {
      await mkdir(dirname(enabledSkillPath), { recursive: true });
      await mkdir(dirname(disabledSkillPath), { recursive: true });
      await writeFile(
        enabledSkillPath,
        [
          "---",
          "name: enabled-runtime-skill",
          "description: Runtime enabled test skill",
          "---",
          "Use this skill only in the runtime enabled test.",
        ].join("\n"),
      );
      await writeFile(
        disabledSkillPath,
        [
          "---",
          "name: disabled-runtime-skill",
          "description: Runtime disabled test skill",
          "---",
          "Use this skill only in the runtime disabled test.",
        ].join("\n"),
      );
      await writeFile(
        configPath,
        JSON.stringify({
          skills: {
            [disabledSkillPath]: { enable: false },
          },
        }),
      );

      app = await createZCodeApp({
        env: {
          HOME: tempRoot,
          ZCODE_STORAGE_DIR: tempRoot,
        },
        modelExecutor: {
          async generateText(request: { messages: Array<{ content: unknown; role: string }> }) {
            requests.push(request.messages);
            return {
              finishReason: "stop",
              text: "done",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never,
        projectConfigPath: configPath,
        runtimeConfig: {
          workingDirectory: tempRoot,
        },
        sessionId: createSessionId("bootstrap-skill-disable"),
        sessionStore: store,
        skipUserConfig: true,
      });

      await app.submitPrompt("hello");

      const context = (requests.at(-1) ?? [])
        .map((message) =>
          typeof message.content === "string" ? message.content : JSON.stringify(message.content),
        )
        .join("\n");
      expect(context).toContain("enabled-runtime-skill");
      expect(context).not.toContain("disabled-runtime-skill");
    } finally {
      await app?.close?.();
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("schedules log retention cleanup after app startup completes", async () => {
    const loggerFactory = createRecordingLoggerFactory();
    const store = createSqliteSessionStore({ dbPath: ":memory:" });

    try {
      const app = await createZCodeApp({
        env: {},
        loggerFactory,
        modelExecutor: {
          async generateText() {
            return {
              finishReason: "stop",
              text: "unused",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never,
        runtimeConfig: {
          workingDirectory: process.cwd(),
        },
        sessionStore: store,
        skipUserConfig: true,
      });

      expect(loggerFactory.scheduleCalls).toBe(1);
      const completedIndex = loggerFactory.events.indexOf("bootstrap.app.startup.completed");
      expect(completedIndex).toBeGreaterThanOrEqual(0);
      // 异步初始化后可能已有其他后台日志；契约是清理晚于启动，而不是占据最后两行。
      expect(loggerFactory.events.indexOf("scheduleLogRetentionCleanup")).toBeGreaterThan(
        completedIndex,
      );
      await app.close?.();
    } finally {
      store.close();
    }
  });

  it("resolves auto UI locale from adapter-provided locale hints", async () => {
    const store = createSqliteSessionStore({ dbPath: ":memory:" });

    try {
      const app = await createZCodeApp({
        env: {},
        modelExecutor: {
          async generateText() {
            return {
              finishReason: "stop",
              text: "unused",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never,
        runtimeConfig: {
          workingDirectory: process.cwd(),
        },
        sessionStore: store,
        skipUserConfig: true,
        uiDetectedLocale: "zh_CN.UTF-8",
        uiLocale: "auto",
      });

      expect(app.getLocale()).toBe("zh-CN");
    } finally {
      store.close();
    }
  });

  it("keeps UI locale out of the provider-visible prompt", async () => {
    const store = createSqliteSessionStore({ dbPath: ":memory:" });
    const requests: string[][] = [];

    try {
      const app = await createZCodeApp({
        env: {},
        modelExecutor: {
          async generateText(request) {
            requests.push(request.messages.map((message) => String(message.content)));
            return {
              finishReason: "stop",
              text: "ok",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never,
        runtimeConfig: {
          workingDirectory: process.cwd(),
        },
        sessionStore: store,
        skipUserConfig: true,
        uiDetectedLocale: "zh_CN.UTF-8",
        uiLocale: "auto",
      });

      await app.submitPrompt("hello");

      const firstRequest = requests[0]?.join("\n") ?? "";
      expect(app.getLocale()).toBe("zh-CN");
      expect(firstRequest).toContain("hello");
      // 修复原因：现行 prompt 合同已移除 legacy # Language，UI locale 只影响界面展示。
      expect(firstRequest).not.toContain("# Language");
      expect(firstRequest).not.toContain(
        "Respond in the primary language of the user's current prompt",
      );
      expect(firstRequest).not.toContain("Respond in Chinese");
      expect(firstRequest).not.toContain("Respond in zh-CN");
    } finally {
      store.close();
    }
  });

  it("persists UI locale changes through the app facade", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-bootstrap-locale-"));
    const configPath = join(tempRoot, "config.json");
    const store = createSqliteSessionStore({ dbPath: ":memory:" });
    const requests: string[][] = [];

    try {
      const app = await createZCodeApp({
        env: {},
        modelExecutor: {
          async generateText(request) {
            requests.push(request.messages.map((message) => String(message.content)));
            return {
              finishReason: "stop",
              text: "ok",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never,
        runtimeConfig: {
          workingDirectory: tempRoot,
        },
        sessionStore: store,
        uiLocale: "en-US",
        userConfigPath: configPath,
      });

      const result = await app.setLocale("zh-CN");
      const written = JSON.parse(await readFile(configPath, "utf-8"));

      expect(result.locale).toBe("zh-CN");
      expect(result.previousLocale).toBe("en-US");
      expect(result.requestedLocale).toBe("zh-CN");
      expect(app.getLocale()).toBe("zh-CN");
      expect(written.ui.locale).toBe("zh-CN");

      await app.submitPrompt("hello");

      const firstRequest = requests[0]?.join("\n") ?? "";
      expect(firstRequest).toContain("hello");
      // locale 持久化不应重新把 UI 语言投影到 provider-visible prompt。
      expect(firstRequest).not.toContain("# Language");
      expect(firstRequest).not.toContain(
        "Respond in the primary language of the user's current prompt",
      );
      expect(firstRequest).not.toContain("Respond in Chinese");
      expect(firstRequest).not.toContain("Respond in zh-CN");
    } finally {
      store.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("persists session.version from the injected app version", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-bootstrap-session-version-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const store = createSqliteSessionStore({ dbPath });
    const sessionId = createSessionId("bootstrap-session-version");

    try {
      const app = await createZCodeApp({
        env: {
          ZCODE_STORAGE_DIR: tempRoot,
        },
        modelExecutor: {
          async generateText() {
            return {
              finishReason: "stop",
              text: "done",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never,
        runtimeConfig: {
          workingDirectory: tempRoot,
        },
        sessionId,
        sessionStore: store,
        skipUserConfig: true,
        version: "9.8.7",
      });

      await app.submitPrompt("hello");

      const session = await store.getSession(sessionId);
      expect(session?.version).toBe("9.8.7");
    } finally {
      store.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("persists title metadata and prevents generated titles from overwriting custom titles", async () => {
    const store = createSqliteSessionStore({ dbPath: ":memory:" });
    const sessionId = createSessionId("bootstrap-title-metadata");

    try {
      await store.createSession({
        id: sessionId,
        projectID: createProjectId("title-project"),
        slug: "title-session",
        directory: "/tmp/title-session",
        title: "Manual title",
        titleSource: "custom",
        version: "test",
      });

      const skipped = await store.updateSession({
        expectedTitleSources: ["default", "first_input", "generated"],
        id: sessionId,
        title: "Generated title",
        titleSource: "generated",
      });

      expect(skipped.title).toBe("Manual title");
      expect(skipped.titleSource).toBe("custom");

      const custom = await store.updateSession({
        expectedTitleSources: ["custom"],
        id: sessionId,
        title: "Renamed title",
        titleSource: "custom",
      });

      expect(custom.title).toBe("Renamed title");
      expect(custom.titleSource).toBe("custom");
      expect(custom.time.titleUpdated).toEqual(expect.any(Number));
    } finally {
      store.close();
    }
  });

  it("emits an idempotent target_changed clear event when no goal exists", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-bootstrap-idempotent-goal-clear-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const eventStore = createInMemorySessionEventStore();
    const store = createSqliteSessionStore({ dbPath });

    try {
      const app = await createZCodeApp({
        env: {
          ZCODE_STORAGE_DIR: tempRoot,
        },
        eventStore,
        modelExecutor: {
          async generateText() {
            return {
              finishReason: "stop",
              text: "unused",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never,
        runtimeConfig: {
          workingDirectory: tempRoot,
        },
        sessionId: createSessionId("bootstrap-idempotent-goal-clear"),
        sessionStore: store,
        skipUserConfig: true,
      });

      const cleared = await app.clearTarget();
      const events = await eventStore.getEvents(app.sessionId);
      const targetChangedEvents = events.filter(
        (event) => event.type === SessionEventType.TargetChanged,
      );
      const payload = targetChangedEvents[0]?.payload as TargetChangedPayload | undefined;

      expect(cleared).toBe(false);
      expect(targetChangedEvents).toHaveLength(1);
      expect(payload).toEqual({
        action: "cleared",
        previousTarget: null,
        source: "command",
        target: null,
      });
    } finally {
      store.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("persists a newly set goal objective as the visible user prompt", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-bootstrap-goal-visible-prompt-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const eventStore = createInMemorySessionEventStore();
    const store = createSqliteSessionStore({ dbPath });
    const objective = "加一个地址系统，可以加，可以选";
    const displayText = `/target ${objective}`;
    const sourceCommandId = "command-goal-visible-prompt";
    const queueItemId = "queue-goal-visible-prompt";

    try {
      const app = await createZCodeApp({
        env: {
          ZCODE_STORAGE_DIR: tempRoot,
        },
        eventStore,
        modelExecutor: {
          async generateText() {
            return {
              finishReason: "stop",
              text: "unused",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never,
        runtimeConfig: {
          workingDirectory: tempRoot,
        },
        sessionId: createSessionId("bootstrap-goal-visible-prompt"),
        sessionStore: store,
        skipUserConfig: true,
      });

      await app.runtime.ensureSessionPersistedForExternalActivity(objective);
      await store.saveSessionInput({
        id: queueItemId,
        sessionID: app.sessionId,
        kind: "sendGoalCommand",
        delivery: "startNow",
        payload: { text: displayText },
      });
      const target = await app.setTarget({
        displayText,
        objective,
        intent: {
          sourceCommandId,
          queueItemId,
          clientId: "desktop-test",
          kind: "sendGoalCommand",
          text: objective,
          admissionSeq: 1,
          admittedAt: 1,
          requestedDelivery: "startNow",
          admittedDelivery: "startNow",
        },
      });
      const session = await store.getSession(app.sessionId);
      const messages = await store.messages({ sessionID: app.sessionId });
      const events = await eventStore.getEvents(app.sessionId);
      const targetChangedEvents = events.filter(
        (event) => event.type === SessionEventType.TargetChanged,
      );
      const goalMessage = messages[0];
      const goalMessageText = goalMessage?.parts
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("");

      expect(target.objective).toBe(objective);
      expect(session?.title).toBe(objective);
      expect(goalMessage?.info).toMatchObject({ role: "user" });
      expect(goalMessage?.info).not.toHaveProperty("source");
      expect(goalMessage?.info).not.toHaveProperty("synthetic");
      expect(goalMessage?.info).not.toHaveProperty("visibility");
      expect(goalMessageText).toBe(displayText);
      expect(goalMessage?.info.metadata?.conversationInputIntent).toMatchObject({
        kind: "sendGoalCommand",
        text: objective,
      });
      expect(goalMessage?.info.metadata?.executionKind).toBe("controlOnly");
      const liveProjection = new ProductProjection(app.sessionId, "goal-live");
      for (const event of events) liveProjection.applyEvent(event);
      const coldProjection = new ProductProjection(app.sessionId, "goal-cold");
      for (const event of synthesizeEventsFromMessages(messages, { sessionId: app.sessionId })) {
        coldProjection.applyEvent(event);
      }
      const visibleGoalRows = (projection: ProductProjection) =>
        projection
          .getSnapshot()
          .rows.window.filter((row) => row.kind === "userInput")
          .map((row) => (row.kind === "userInput" ? row.text : ""));
      // 回归：/goal 首轮必须随 live 事件立即出现；cold hydration 复用同一条原始文本，
      // 不能只在重启后显示，也不能退化成解析后的 objective。
      expect(visibleGoalRows(liveProjection)).toEqual([displayText]);
      expect(visibleGoalRows(coldProjection)).toEqual([displayText]);
      const visibleGoalHeader = (projection: ProductProjection) =>
        projection
          .getSnapshot()
          .rows.window.find(
            (row) => row.kind === "turnHeader" && row.turnId === String(goalMessage?.info.id),
          );
      expect(visibleGoalHeader(liveProjection)).toMatchObject({
        executionKind: "controlOnly",
        state: "completedSuccess",
      });
      expect(visibleGoalHeader(coldProjection)).toMatchObject({
        executionKind: "controlOnly",
        state: "completedSuccess",
      });
      expect(visibleGoalHeader(liveProjection)).not.toHaveProperty("activeMs");
      expect(
        liveProjection.resolveEditTargetByEntityId(String(goalMessage?.info.id)).intent,
      ).toMatchObject({ kind: "sendGoalCommand", text: objective });
      const commandTargetChangedEvent = targetChangedEvents.find(
        (event) => (event.payload as TargetChangedPayload).source === "command",
      );
      expect(commandTargetChangedEvent?.payload).toMatchObject({
        action: "set",
        source: "command",
        target: expect.objectContaining({ objective }),
      });
    } finally {
      store.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("initializes the Bash shell snapshot before a goal-only first input persists the session", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-bootstrap-goal-shell-"));
    const shellDir = join(tempRoot, "bin");
    const zshPath = join(shellDir, "zsh");
    const dbPath = join(tempRoot, "session.sqlite");
    const store = createSqliteSessionStore({ dbPath });

    try {
      await mkdir(shellDir, { recursive: true });
      await writeFile(zshPath, "#!/bin/sh\n");
      await chmod(zshPath, 0o755);
      const app = await createZCodeApp({
        env: {
          PATH: shellDir,
          SHELL: join(shellDir, "fish"),
          ZCODE_STORAGE_DIR: tempRoot,
        },
        modelExecutor: {
          async generateText() {
            return {
              finishReason: "stop",
              text: "unused",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never,
        runtimeConfig: {
          workingDirectory: tempRoot,
        },
        sessionId: createSessionId("bootstrap-goal-shell-snapshot"),
        sessionStore: store,
        skipUserConfig: true,
      });

      await app.setTarget({ objective: "goal-only first input" });

      const entries = await store.sessionEntries({
        sessionID: app.sessionId,
        type: SESSION_ENTRY_BASH_SHELL_SELECTION,
      });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.data).toMatchObject({
        display: { name: "zsh" },
        path: zshPath,
      });
    } finally {
      store.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("persists replacement goal objective as real user prompt without state reminders", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-bootstrap-goal-replace-hidden-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const eventStore = createInMemorySessionEventStore();
    const store = createSqliteSessionStore({ dbPath });
    const initialObjective = "加一个地址系统，可以加，可以选";
    const replacementObjective = "改成只支持默认地址";
    const initialDisplayText = `/goal ${initialObjective}`;
    const replacementDisplayText = `/GoAl replace ${replacementObjective}`;

    try {
      const app = await createZCodeApp({
        env: {
          ZCODE_STORAGE_DIR: tempRoot,
        },
        eventStore,
        modelExecutor: {
          async generateText() {
            return {
              finishReason: "stop",
              text: "unused",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never,
        runtimeConfig: {
          workingDirectory: tempRoot,
        },
        sessionId: createSessionId("bootstrap-goal-replace-hidden"),
        sessionStore: store,
        skipUserConfig: true,
      });

      await app.setTarget({
        displayText: initialDisplayText,
        objective: initialObjective,
        status: "active",
      });
      const replacedTarget = await app.setTarget({
        displayText: replacementDisplayText,
        objective: replacementObjective,
        status: "active",
      });
      const messages = await store.messages({ sessionID: app.sessionId });
      const realUserMessages = messages.filter(
        (message) => message.info.role === "user" && message.info.synthetic !== true,
      );
      const goalStateReminderMessages = messages.filter(
        (message) =>
          message.info.role === "user" &&
          message.info.synthetic === true &&
          message.info.source === "goal_state_change",
      );
      const targetChangedEvents = (await eventStore.getEvents(app.sessionId)).filter(
        (event) => event.type === SessionEventType.TargetChanged,
      );
      const commandTargetChangedEvents = targetChangedEvents.filter(
        (event) => (event.payload as TargetChangedPayload).source === "command",
      );
      const userMessageTexts = realUserMessages.map((message) =>
        message.parts.map((part) => (part.type === "text" ? part.text : "")).join(""),
      );
      const reminderTexts = goalStateReminderMessages.map((message) =>
        message.parts.map((part) => (part.type === "text" ? part.text : "")).join(""),
      );

      expect(replacedTarget.objective).toBe(replacementObjective);
      expect(userMessageTexts).toEqual([initialDisplayText, replacementDisplayText]);
      expect(reminderTexts).toEqual([]);
      expect(commandTargetChangedEvents).toHaveLength(2);
      expect(commandTargetChangedEvents[1]?.payload).toMatchObject({
        action: "set",
        previousTarget: expect.objectContaining({ objective: initialObjective }),
        source: "command",
        target: expect.objectContaining({ objective: replacementObjective }),
      });
    } finally {
      store.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("persists model-only goal state change reminders for goal lifecycle changes", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-bootstrap-goal-state-reminders-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const store = createSqliteSessionStore({ dbPath });

    try {
      const app = await createZCodeApp({
        env: {
          ZCODE_STORAGE_DIR: tempRoot,
        },
        modelExecutor: {
          async generateText() {
            return {
              finishReason: "stop",
              text: "unused",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never,
        runtimeConfig: {
          workingDirectory: tempRoot,
        },
        sessionId: createSessionId("bootstrap-goal-state-reminders"),
        sessionStore: store,
        skipUserConfig: true,
      });

      await app.setTarget({ objective: "ship the first goal" });
      await app.updateTargetStatus("paused");
      await app.updateTargetStatus("paused");
      await app.setTarget({ objective: "ship the replacement goal", status: "active" });
      await app.clearTarget();

      const messages = await store.messages({ sessionID: app.sessionId });
      const reminderParts = messages.flatMap((message) =>
        message.parts
          .filter(
            (part) =>
              part.type === "text" &&
              part.synthetic === true &&
              part.metadata?.source === "goal_state_change",
          )
          .map((part) => ({ message, part })),
      );

      expect(reminderParts.map(({ part }) => part.text)).toEqual([
        "The active session goal is paused. Do not continue pursuing it unless the user resumes or replaces the goal.",
        "The session goal is active again and will be pursued.",
        "The session goal has been cleared. Do not continue pursuing any previous goal unless the user sets a new goal.",
      ]);
      for (const { message, part } of reminderParts) {
        expect(message.info).toMatchObject({
          role: "user",
          source: "goal_state_change",
          synthetic: true,
          visibility: "model-only",
        });
        expect(part.metadata).toMatchObject({
          runtimeMessage: { source: "goal_state_change" },
          source: "goal_state_change",
          visibility: "model-only",
        });
      }
    } finally {
      store.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("uses the current model for new expert workflow child sessions after a model switch", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-bootstrap-workflow-model-switch-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const store = createSqliteSessionStore({ dbPath });
    const requestModels: string[] = [];

    try {
      let switched = false;
      let app: Awaited<ReturnType<typeof createZCodeApp>>;
      app = await createZCodeApp({
        configuredDefaultModelSelection: {
          providerId: "zai",
          modelId: "glm-main",
          options: { reasoningLevel: "high" },
        },
        env: {
          ZCODE_STORAGE_DIR: tempRoot,
        },
        modelExecutor: {
          setModelIoFullRetentionEnabled() {},
          async generateText(
            _request: unknown,
            execution: { model: { modelId: string; providerId: string } },
          ) {
            requestModels.push(`${execution.providerId}/${execution.modelId}`);
            if (!switched) {
              switched = true;
              await app.setModel("deepseek/deepseek-v4-pro");
              await app.setThoughtLevel("high");
            }
            return {
              finishReason: "stop",
              text: JSON.stringify({
                reasoning: "ok",
                verdict: "pass",
              }),
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never,
        providerRegistry: createTestProviderRegistry([
          { providerId: "zai", modelId: "glm-main" },
          { providerId: "deepseek", modelId: "deepseek-v4-pro" },
        ]),
        runtimeConfig: {
          workingDirectory: tempRoot,
        },
        sessionId: createSessionId("bootstrap-workflow-model-switch"),
        sessionStore: store,
        skipUserConfig: true,
      });

      const result = await app.runExpertWorkflow({
        task: "verify workflow model switching",
      });

      expect(result.status).toBe("completed");
      expect(requestModels[0]).toBe("zai/glm-main");
      expect(requestModels.slice(1)).toContain("deepseek/deepseek-v4-pro");
      expect(result.snapshot?.sessionLinks.map((link) => link.model)).toContain(
        "deepseek/deepseek-v4-pro",
      );
    } finally {
      store.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("initializes the Bash shell snapshot before direct expert workflow child sessions", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-bootstrap-workflow-shell-"));
    const configPath = join(tempRoot, "config.json");
    const shellDir = join(tempRoot, "bin");
    const zshPath = join(shellDir, "zsh");
    const dbPath = join(tempRoot, "session.sqlite");
    const store = createSqliteSessionStore({ dbPath });
    const requestTexts: string[] = [];

    try {
      await mkdir(shellDir, { recursive: true });
      await writeFile(zshPath, "#!/bin/sh\n");
      await chmod(zshPath, 0o755);
      await writeFile(
        configPath,
        JSON.stringify({
          provider: {
            zai: {
              kind: "openai-compatible",
              options: {
                apiKey: "zai-secret",
                baseURL: "https://api.z.ai/api/coding/v1",
              },
              models: {
                "glm-main": {},
              },
            },
          },
          model: "zai/glm-main",
        }),
      );

      const app = await createZCodeApp({
        env: {
          PATH: shellDir,
          SHELL: join(shellDir, "fish"),
          ZCODE_STORAGE_DIR: tempRoot,
        },
        modelExecutor: {
          setModelIoFullRetentionEnabled() {},
          async generateText(request: { messages: Array<{ content: unknown }> }) {
            requestTexts.push(JSON.stringify(request.messages));
            return {
              finishReason: "stop",
              text: JSON.stringify({
                reasoning: "ok",
                verdict: "pass",
              }),
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never,
        projectConfigPath: configPath,
        runtimeConfig: {
          workingDirectory: tempRoot,
        },
        sessionId: createSessionId("bootstrap-workflow-shell-snapshot"),
        sessionStore: store,
        skipUserConfig: true,
      });

      await app.runExpertWorkflow({
        task: "verify workflow shell snapshot",
      });

      const providerText = requestTexts.join("\n");
      expect(providerText).toContain("- Shell: zsh");
      expect(providerText).not.toContain("- Shell: fish");
    } finally {
      store.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("reads built-in expert workflow snapshots without requiring an external expert definition file", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-bootstrap-workflow-builtin-"));
    const workflowStore = createNodeWorkflowStore({
      rootDir: join(tempRoot, "cli", "workflows"),
    });
    const runId = "wf_expert_builtin_snapshot";
    const timestamp = new Date(0).toISOString();
    const snapshot: WorkflowRunSnapshot = {
      activities: [],
      artifacts: [],
      createdAt: timestamp,
      cwd: tempRoot,
      definitionId: "expert",
      definitionVersion: "2",
      graph: {
        edges: [],
        nodes: [
          {
            dependsOn: [],
            id: "phase:exec",
            kind: "phase",
            phase: "exec",
            status: "completed",
            title: "Exec",
          },
        ],
      },
      kind: "expert",
      phaseOrder: ["exec"],
      phases: [
        {
          phase: "exec",
          status: "completed",
        },
      ],
      runId,
      schemaVersion: 1,
      status: "completed",
      strategy: DEFAULT_EXPERT_WORKFLOW_STRATEGY,
      task: "status existing expert workflow",
      updatedAt: timestamp,
    };

    try {
      await workflowStore.writeSnapshot(snapshot);
      const app = await createZCodeApp({
        env: {
          ZCODE_STORAGE_DIR: tempRoot,
        },
        modelExecutor: {
          setModelIoFullRetentionEnabled() {},
          async generateText() {
            return {
              finishReason: "stop",
              text: "unused",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never,
        runtimeConfig: {
          workingDirectory: tempRoot,
        },
        sessionId: createSessionId("bootstrap-workflow-builtin"),
        skipUserConfig: true,
      });

      await expect(app.workflowStatus?.({ runId, workflowKind: "expert" })).resolves.toMatchObject({
        runId,
        snapshot: {
          definitionId: "expert",
          kind: "expert",
        },
        status: "completed",
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("opens the default session store from the configured db path", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-bootstrap-session-db-"));
    const dbPath = join(tempRoot, "db", "db.sqlite");

    try {
      const latest = await resolveLatestSession({
        directory: tempRoot,
        env: {
          ZCODE_SESSION_DB_PATH: dbPath,
        },
      });

      expect(latest).toBeNull();
      expect((await stat(dbPath)).isFile()).toBe(true);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("blocks app startup on database migration before resolving model config", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-bootstrap-migration-gate-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      create table schema_migration (
        id text primary key,
        checksum text not null,
        app_version text,
        time_applied integer not null
      );
      insert into schema_migration (id, checksum, app_version, time_applied)
      values ('0001_base_session_store', 'not-the-current-checksum', '0.2.0', 1);
    `);
    db.close();

    try {
      await expect(
        createZCodeApp({
          env: {
            ZCODE_SESSION_DB_PATH: dbPath,
          },
          runtimeConfig: {
            workingDirectory: tempRoot,
          },
          skipUserConfig: true,
        }),
      ).rejects.toThrow(/SQLite migration checksum mismatch for 0001_base_session_store/);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("blocks ZCode Protocol startup on database migration before protocol connection", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-protocol-migration-gate-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      create table schema_migration (
        id text primary key,
        checksum text not null,
        app_version text,
        time_applied integer not null
      );
      insert into schema_migration (id, checksum, app_version, time_applied)
      values ('0001_base_session_store', 'not-the-current-checksum', '0.2.0', 1);
    `);
    db.close();
    const output = createMemoryWritable();
    const providerEnv = await createProtocolProviderEnv(tempRoot);

    try {
      await expect(
        runZCodeProtocolAgent({
          env: {
            ...providerEnv,
            ZCODE_SESSION_DB_PATH: dbPath,
          },
          input: createNeverEndingReadable(),
          output,
        }),
      ).rejects.toThrow(/SQLite migration checksum mismatch for 0001_base_session_store/);
      expect(output.output()).toBe("");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("schedules log retention cleanup after ZCode Protocol startup completes", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-protocol-log-retention-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const output = createMemoryWritable();
    const input = createClosableReadable();
    const providerEnv = await createProtocolProviderEnv(tempRoot);

    try {
      await runZCodeProtocolAgent({
        env: {
          ...providerEnv,
          ZCODE_LOG_DIR: join(tempRoot, "log"),
          ZCODE_SESSION_DB_PATH: dbPath,
          ZCODE_STORAGE_DIR: tempRoot,
        },
        input,
        output,
      });

      const logEntries = await readLogEntries(join(tempRoot, "log"));
      const startupCompletedIndex = logEntries.findIndex(
        (entry) => entry.event === "zcode_protocol.startup.completed",
      );
      const retentionScheduledIndex = logEntries.findIndex(
        (entry) => entry.event === "log.retention.cleanup.scheduled",
      );

      expect(startupCompletedIndex).toBeGreaterThanOrEqual(0);
      expect(retentionScheduledIndex).toBeGreaterThan(startupCompletedIndex);
      expect(output.output()).toBe("");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("routes AI SDK warnings away from ZCode Protocol stdout", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-protocol-ai-sdk-warning-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const logDir = join(tempRoot, "log");
    const output = createMemoryWritable();
    const originalWarningLogger = (globalThis as AiSdkWarningGlobal).AI_SDK_LOG_WARNINGS;
    const providerEnv = await createProtocolProviderEnv(tempRoot);

    try {
      await runZCodeProtocolAgent({
        env: {
          ...providerEnv,
          ZCODE_LOG_DIR: logDir,
          ZCODE_SESSION_DB_PATH: dbPath,
          ZCODE_STORAGE_DIR: tempRoot,
        },
        input: createClosableReadable(),
        output,
      });

      const warningLogger = (globalThis as AiSdkWarningGlobal).AI_SDK_LOG_WARNINGS;
      if (typeof warningLogger === "function") {
        warningLogger({
          model: "claude-opus-test",
          provider: "anthropic.messages",
          warnings: [{ type: "unsupported", feature: "temperature" }],
        });
      }

      expect(output.output()).toBe("");
      const logEntries = await readLogEntries(logDir);
      expect(logEntries.some((entry) => entry.event === "model.sdk.warning")).toBe(true);
    } finally {
      (globalThis as AiSdkWarningGlobal).AI_SDK_LOG_WARNINGS = originalWarningLogger;
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("loads project AGENTS.md into the default prompt context", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-bootstrap-instructions-"));
    const workspace = join(tempRoot, "workspace");
    const nestedCwd = join(workspace, "packages", "app");
    const dbPath = join(tempRoot, "session.sqlite");
    const store = createSqliteSessionStore({ dbPath });
    let capturedSystem = "";
    let capturedMetaUser = "";

    try {
      await mkdir(nestedCwd, { recursive: true });
      await mkdir(join(workspace, ".git"));
      await writeFile(join(workspace, "AGENTS.md"), "Always follow marker: project-rule-314.\n");

      const app = await createZCodeApp({
        env: {
          ZCODE_STORAGE_DIR: tempRoot,
        },
        modelExecutor: {
          async generateText(request: { messages: Array<{ role: string; content: string }> }) {
            capturedSystem = request.messages
              .filter((message) => message.role === "system")
              .map((message) => message.content)
              .join("\n");
            capturedMetaUser =
              request.messages.find(
                (message) =>
                  message.role === "user" &&
                  message.content.includes(
                    `Contents of ${join(workspace, "AGENTS.md")} (workspace instructions):`,
                  ),
              )?.content ?? "";
            return {
              text: "done",
              finishReason: "stop",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never,
        runtimeConfig: {
          workingDirectory: nestedCwd,
        },
        sessionId: createSessionId("bootstrap-default-instructions"),
        sessionStore: store,
      });

      const result = await app.submitPrompt("hello");

      expect(result.response).toBe("done");
      expect(capturedSystem).not.toContain("project-rule-314");
      // 修复原因：workspace instructions 直接作为 meta user context 注入，标题只标识 AGENTS.md。
      expect(capturedMetaUser).toContain("# agentsMd");
      expect(capturedMetaUser).not.toContain("# claudeMd");
      expect(capturedMetaUser).not.toContain("# user_instructions");
      expect(capturedMetaUser).toContain("Codebase and user instructions are shown below.");
      expect(capturedMetaUser).toContain(
        `Contents of ${join(workspace, "AGENTS.md")} (workspace instructions):`,
      );
      expect(capturedMetaUser).toContain("project-rule-314");
    } finally {
      store.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("wires oversized tool results into the default artifact store", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-bootstrap-artifacts-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const eventStore = createInMemorySessionEventStore();
    const store = createSqliteSessionStore({ dbPath });
    const largeStdout = `BEGIN_FULL_OUTPUT\n${"x".repeat(50_000)}`;
    let modelCallCount = 0;
    let followupToolMessage = "";
    const executionPort = {
      async run() {
        const now = new Date();
        return {
          status: "completed",
          exitCode: 0,
          stdout: {
            text: largeStdout,
            bytes: Buffer.byteLength(largeStdout, "utf8"),
            truncated: false,
          },
          stderr: {
            text: "",
            bytes: 0,
            truncated: false,
          },
          durationMs: 1,
          timedOut: false,
          cancelled: false,
          startedAt: now,
          completedAt: now,
        };
      },
    } satisfies ExecutionPort;

    try {
      const app = await createZCodeApp({
        env: {
          ZCODE_STORAGE_DIR: tempRoot,
        },
        eventStore,
        executionPort,
        modelExecutor: {
          async generateText(request: { messages: Array<{ role: string; content: string }> }) {
            modelCallCount++;
            if (modelCallCount === 1) {
              return {
                text: "",
                finishReason: "tool-calls",
                usage: {
                  inputTokens: 1,
                  outputTokens: 1,
                  totalTokens: 2,
                },
                toolCalls: [
                  {
                    id: "large-bash-output",
                    name: "Bash",
                    input: {
                      command: "generate large output",
                      description: "Generate large fixture output",
                    },
                  },
                ],
              };
            }

            followupToolMessage =
              request.messages.find((message) => message.role === "tool")?.content ?? "";
            return {
              text: "done",
              finishReason: "stop",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never,
        runtimeConfig: {
          // 该测试冻结两次 Main 请求来验证 artifact 投影；Extraction 是独立模型链，
          // 必须关闭以免第三次请求覆盖 followupToolMessage。
          memory: { enabled: false },
          mode: "yolo",
          workingDirectory: tempRoot,
        },
        sessionId: createSessionId("bootstrap-artifact-store"),
        sessionStore: store,
      });

      const result = await app.submitPrompt("produce large output");
      const events = await eventStore.getEvents(app.sessionId);
      const toolResultEvent = events.find(
        (event) => event.type === SessionEventType.ToolCallResult,
      );
      const toolResultPayload = toolResultEvent?.payload as any;
      const artifactPath = toolResultPayload.result.artifactPath as string;
      if (typeof artifactPath !== "string") {
        throw new Error("Expected oversized tool result to include an artifactPath");
      }
      const artifactDir = dirname(artifactPath);
      const files = await readdir(artifactDir);
      const artifactContent = await readFile(artifactPath, "utf8");

      expect(result.response).toBe("done");
      expect(artifactPath).toContain(join(tempRoot, "cli", "artifacts", app.sessionId));
      expect(files).toHaveLength(1);
      expect(artifactContent).toContain("BEGIN_FULL_OUTPUT");
      // 回归原因：大结果落盘后，provider-visible 内容会使用统一的
      // <persisted-output> envelope，并保留前 2KB preview，而不是旧 artifactPath 键值。
      expect(followupToolMessage).toContain("<persisted-output>");
      expect(followupToolMessage).toContain(
        `Output too large (48.8KB). Full output saved to: ${artifactPath}`,
      );
      expect(followupToolMessage).toContain("Preview (first 2KB):");
      expect(followupToolMessage).toContain("BEGIN_FULL_OUTPUT");
      expect(followupToolMessage).toContain("...\n</persisted-output>");
      expect(followupToolMessage.length).toBeLessThan(artifactContent.length);
      expect(toolResultPayload.result.artifactPath).toBe(artifactPath);
      expect(toolResultPayload.result.truncated).toBe(true);
    } finally {
      store.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("persists 10 multi-turn tool cases and keeps logs aligned with the database", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-session-persistence-"));
    const configPath = join(tempRoot, "config.json");
    const dbPath = join(tempRoot, "session.sqlite");
    const logDir = join(tempRoot, "log");
    const fixturePath = join(tempRoot, "fixture.txt");
    const prompts = Array.from({ length: 10 }, (_, index) => `case ${index + 1}: read fixture`);
    const responses = prompts.flatMap((prompt, index) => [
      {
        text: `checking ${prompt}`,
        finishReason: "tool-calls",
        usage: {
          inputTokens: 10 + index,
          outputTokens: 5,
          totalTokens: 15 + index,
        },
        toolCalls: [
          {
            id: `case-${index + 1}-read`,
            name: "Read",
            input: {
              file_path: fixturePath,
              limit: 1,
            },
          },
        ],
      },
      {
        text: `answer ${index + 1}`,
        finishReason: "stop",
        usage: {
          inputTokens: 12 + index,
          outputTokens: 6,
          totalTokens: 18 + index,
        },
      },
    ]);

    const modelExecutor = {
      async generateText() {
        const next = responses.shift();
        if (!next) throw new Error("unexpected model call");
        return next;
      },
    };

    const store = createSqliteSessionStore({ dbPath });

    try {
      await writeFile(fixturePath, "fixture-line\nsecond-line\n", "utf8");
      // Bugfix：这个用例断言精确消息数，必须关闭默认 skill 扫描。
      // 否则真实用户目录里的 SKILL.md 会注入额外上下文消息，让持久化计数依赖本机状态。
      await writeFile(configPath, JSON.stringify({ skills: { enabled: false } }), "utf8");

      const app = await createZCodeApp({
        env: {},
        loggerFactory: createNodeLoggerFactory({ logDir, minLevel: LogLevel.Debug }),
        modelExecutor: modelExecutor as never,
        projectConfigPath: configPath,
        runtimeConfig: {
          // 这个用例固定 20 次 Main 模型响应与 transcript 计数；后台 Memory Extraction
          // 是独立请求链，需显式关闭，避免消费 Main fixture。
          memory: { enabled: false },
          mode: "plan",
          // 这个计数用例只覆盖 Read 工具持久化；收窄工具集，避免 TodoWrite reminder 插入合成消息。
          toolAllowlist: ["Read"],
          workingDirectory: tempRoot,
        },
        sessionId: createSessionId("persistence-10-cases"),
        sessionStore: store,
        skipUserConfig: true,
      });

      for (const prompt of prompts) {
        const result = await app.submitPrompt(prompt);
        expect(result.response).toMatch(/^answer \d+$/);
      }

      expect(responses).toHaveLength(0);

      const counts = store.debugCounts(app.sessionId);
      const messages = await store.messages({ sessionID: app.sessionId });
      const parts = messages.flatMap((message) => message.parts);
      const userMessages = messages.filter((message) => message.info.role === "user");
      const assistantMessages = messages.filter((message) => message.info.role === "assistant");
      const toolParts = parts.filter((part) => part.type === "tool");

      expect(counts.sessions).toBe(1);
      expect(counts.messages).toBe(30);
      expect(counts.parts).toBe(80);
      expect(userMessages).toHaveLength(10);
      expect(assistantMessages).toHaveLength(20);
      expect(toolParts).toHaveLength(10);
      expect(
        toolParts.every((part) => part.type === "tool" && part.state.status === "completed"),
      ).toBe(true);
      const completedToolOutputs = toolParts.flatMap((part) =>
        part.type === "tool" && part.state.status === "completed" ? [part.state.output] : [],
      );
      // 回归原因：同一未变化范围只在首次 Read 返回正文；后续调用持久化固定的
      // file_unchanged stub，避免重复把相同文件内容注入模型上下文。
      expect(completedToolOutputs).toHaveLength(10);
      expect(completedToolOutputs[0]).toContain("fixture-line");
      expect(completedToolOutputs.slice(1)).toEqual(
        Array.from(
          { length: 9 },
          () =>
            "Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.",
        ),
      );

      const logEntries = await readLogEntries(logDir);
      const persistedSessionEntries = logEntries.filter(
        (entry) => entry.event === "session.persisted",
      );
      const persistedMessageEntries = logEntries.filter(
        (entry) => entry.event === "session.message.persisted",
      );
      const persistedPartEntries = logEntries.filter(
        (entry) => entry.event === "session.part.persisted",
      );

      expect(persistedSessionEntries).toHaveLength(1);
      expect(uniqueContextValues(persistedMessageEntries, "messageId").size).toBe(counts.messages);
      expect(uniqueContextValues(persistedPartEntries, "partId").size).toBe(counts.parts);
    } finally {
      store.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("registers submitPrompt live event handlers only for the active turn", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-submit-live-events-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const logDir = join(tempRoot, "log");
    const responses = [
      {
        text: "first live answer",
        finishReason: "stop",
        usage: {
          inputTokens: 1,
          outputTokens: 2,
          totalTokens: 3,
        },
      },
      {
        text: "second live answer",
        finishReason: "stop",
        usage: {
          inputTokens: 2,
          outputTokens: 3,
          totalTokens: 5,
        },
      },
    ];
    const store = createSqliteSessionStore({ dbPath });
    const liveEventTypes: string[] = [];

    try {
      const app = await createZCodeApp({
        env: {},
        eventStore: createInMemorySessionEventStore(),
        loggerFactory: createNodeLoggerFactory({ logDir, minLevel: LogLevel.Debug }),
        modelExecutor: {
          async generateText() {
            const next = responses.shift();
            if (!next) throw new Error("unexpected model request");
            return next;
          },
        } as never,
        runtimeConfig: {
          workingDirectory: tempRoot,
        },
        sessionId: createSessionId("submit-live-events"),
        sessionStore: store,
      });

      const first = await app.submitPrompt("first prompt", {
        onEvent: (event) => {
          liveEventTypes.push(event.type);
        },
      });
      const firstEventCount = liveEventTypes.length;
      const second = await app.submitPrompt("second prompt");

      expect(first.response).toBe("first live answer");
      expect(second.response).toBe("second live answer");
      // Bugfix: ensureSessionPersisted 现在会 appendEvent 一条 session.titleUpdated（source="first_input"），
      // 紧贴在 TurnStarted 之前。这里把它作为合法首项接受。
      expect(liveEventTypes).toEqual([
        SessionEventType.SessionTitleUpdated,
        SessionEventType.TurnStarted,
        SessionEventType.ModelRequest,
        SessionEventType.ModelComplete,
        SessionEventType.TurnComplete,
      ]);
      expect(liveEventTypes).toHaveLength(firstEventCount);
    } finally {
      store.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps builtin prompt command text visible while sending the expanded runtime prompt", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-builtin-init-visible-prompt-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const store = createSqliteSessionStore({ dbPath });
    let capturedMessages: Array<{ content: string; role: string }> = [];

    try {
      const app = await createZCodeApp({
        env: {},
        eventStore: createInMemorySessionEventStore(),
        modelExecutor: {
          async generateText(request: { messages: Array<{ content: string; role: string }> }) {
            capturedMessages = request.messages;
            return {
              text: "created AGENTS",
              finishReason: "stop",
              usage: {
                inputTokens: 1,
                outputTokens: 2,
                totalTokens: 3,
              },
            };
          },
        } as never,
        runtimeConfig: {
          workingDirectory: tempRoot,
        },
        sessionId: createSessionId("builtin-init-visible-prompt"),
        sessionStore: store,
      });

      const result = await app.submitPrompt("/init include package scripts");
      const turnStarted = result.events.find(
        (event) => event.type === SessionEventType.TurnStarted,
      );

      expect(
        capturedMessages.some(
          (message) =>
            message.role === "user" && message.content.includes("built-in /init command"),
        ),
      ).toBe(true);
      expect(turnStarted?.payload).toMatchObject({
        input: "/init include package scripts",
      });
      await expect(app.loadSessionTranscript()).resolves.toEqual([
        {
          content: "/init include package scripts",
          role: "user",
        },
        {
          content: "created AGENTS",
          role: "agent",
        },
      ]);
    } finally {
      store.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps sendInput(auto) queued until the command layer promotes it", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-send-input-steer-"));
    const modelStarted = deferred();
    const finishFirstModel = deferred();
    const liveEventTypes: string[] = [];
    let modelCallCount = 0;
    let secondRequestMessages: Array<{ content: string; role: string }> = [];

    try {
      const app = await createZCodeApp({
        env: {},
        eventStore: createInMemorySessionEventStore(),
        modelExecutor: {
          async generateText(request: { messages: Array<{ content: string; role: string }> }) {
            modelCallCount++;
            if (modelCallCount === 1) {
              modelStarted.resolve();
              await finishFirstModel.promise;
              return {
                finishReason: "stop",
                text: "first answer",
                usage: {
                  inputTokens: 1,
                  outputTokens: 1,
                  totalTokens: 2,
                },
              };
            }

            secondRequestMessages = request.messages;
            return {
              finishReason: "stop",
              text: "second answer",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never,
        runtimeConfig: {
          workingDirectory: tempRoot,
        },
        sessionId: createSessionId("send-input-steer"),
      });

      const pendingTurn = app.submitPrompt("first prompt", {
        onEvent: (event) => {
          liveEventTypes.push(event.type);
        },
      });
      await modelStarted.promise;

      const queued = await app.sendInput("queued through app", { delivery: "auto" });
      finishFirstModel.resolve();
      const result = await pendingTurn;

      expect(queued).toMatchObject({
        kind: "queued",
        queueLength: 1,
      });
      expect(result.response).toBe("first answer");
      expect(secondRequestMessages).toEqual([]);
      expect(liveEventTypes).toContain(SessionEventType.TurnSteerQueued);
      expect(liveEventTypes).not.toContain(SessionEventType.TurnSteerDrained);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("records accepted prompt and steered input history through the app contract", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-input-history-app-"));
    const store = createSqliteSessionStore({ dbPath: join(tempRoot, "session.sqlite") });
    const modelStarted = deferred();
    const finishFirstModel = deferred();
    let modelCallCount = 0;

    try {
      const app = await createZCodeApp({
        env: {},
        eventStore: createInMemorySessionEventStore(),
        modelExecutor: {
          async generateText() {
            modelCallCount++;
            if (modelCallCount === 1) {
              modelStarted.resolve();
              await finishFirstModel.promise;
            }
            return {
              finishReason: "stop",
              text: modelCallCount === 1 ? "first answer" : "second answer",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never,
        runtimeConfig: {
          workingDirectory: tempRoot,
        },
        sessionId: createSessionId("input-history-app"),
        sessionStore: store,
      });

      const firstPrompt = {
        attachments: [
          {
            content: "data:image/png;base64,aW1hZ2U=",
            path: "[image #1]",
            type: "image" as const,
          },
        ],
        text: "[image #1] first prompt",
      };
      const pendingTurn = app.submitPrompt(firstPrompt);
      await modelStarted.promise;
      expect(await app.recallPreviousInputHistory()).toMatchObject({
        attachments: firstPrompt.attachments,
        kind: "prompt",
        text: "[image #1] first prompt",
      });
      const storedPromptHistory = await store.recallPreviousInputHistory({
        projectID: testProjectIdFromDirectory(tempRoot),
      });
      expect(storedPromptHistory?.attachments?.[0]?.content).toMatch(/^zcode-artifact:\/\//);
      expect(storedPromptHistory?.attachments?.[0]?.content).not.toContain("base64");

      await app.sendInput("queued through app", { delivery: "auto" });
      expect(await app.recallPreviousInputHistory()).toMatchObject({
        kind: "steered_input",
        text: "queued through app",
      });
      finishFirstModel.resolve();
      await pendingTurn;
    } finally {
      store.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("restores project-scoped mode from local settings unless CLI overrides it", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-project-mode-local-setting-"));
    const otherRoot = await mkdtemp(join(tmpdir(), "zcode-project-mode-other-"));
    const store = createSqliteSessionStore({ dbPath: join(tempRoot, "session.sqlite") });

    try {
      const firstApp = await createZCodeApp({
        env: {},
        eventStore: createInMemorySessionEventStore(),
        modelExecutor: {
          async generateText() {
            return {
              finishReason: "stop",
              text: "unused",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never,
        runtimeConfig: {
          workingDirectory: tempRoot,
        },
        sessionId: createSessionId("project-mode-first"),
        sessionStore: store,
      });

      await firstApp.setMode("yolo");

      const restoredApp = await createZCodeApp({
        env: {},
        eventStore: createInMemorySessionEventStore(),
        modelExecutor: {
          async generateText() {
            return {
              finishReason: "stop",
              text: "unused",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never,
        runtimeConfig: {
          workingDirectory: tempRoot,
        },
        sessionId: createSessionId("project-mode-restored"),
        sessionStore: store,
      });
      expect(restoredApp.getMode()).toBe("yolo");

      const otherProjectApp = await createZCodeApp({
        env: {},
        eventStore: createInMemorySessionEventStore(),
        modelExecutor: {
          async generateText() {
            return {
              finishReason: "stop",
              text: "unused",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never,
        runtimeConfig: {
          workingDirectory: otherRoot,
        },
        sessionId: createSessionId("project-mode-other"),
        sessionStore: store,
      });
      expect(otherProjectApp.getMode()).toBe("build");

      const cliOverrideApp = await createZCodeApp({
        env: {},
        eventStore: createInMemorySessionEventStore(),
        modelExecutor: {
          async generateText() {
            return {
              finishReason: "stop",
              text: "unused",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never,
        runtimeConfig: {
          mode: "plan",
          workingDirectory: tempRoot,
        },
        sessionId: createSessionId("project-mode-cli-override"),
        sessionStore: store,
      });
      expect(cliOverrideApp.getMode()).toBe("build");
      expect(cliOverrideApp.runtime.getPlanEnabled()).toBe(true);
    } finally {
      store.close();
      await rm(tempRoot, { recursive: true, force: true });
      await rm(otherRoot, { recursive: true, force: true });
    }
  });

  it("keeps a headless invocation mode when resuming a session with persisted checkpoints", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-headless-resume-mode-"));
    const store = createSqliteSessionStore({ dbPath: join(tempRoot, "session.sqlite") });
    const sessionId = createSessionId("headless-resume-mode");
    const firstFile = join(tempRoot, "step1.txt");
    const secondFile = join(tempRoot, "step2.txt");
    const createWriteModelExecutor = (filePath: string, content: string) => {
      let modelCallCount = 0;
      return {
        async generateText() {
          modelCallCount++;
          if (modelCallCount === 1) {
            return {
              text: "",
              finishReason: "tool-calls",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              toolCalls: [
                {
                  id: `write-${modelCallCount}-${content}`,
                  name: "Write",
                  input: { file_path: filePath, content },
                },
              ],
            };
          }
          return {
            text: "done",
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          };
        },
      };
    };

    try {
      const firstApp = await createZCodeApp({
        env: { ZCODE_STORAGE_DIR: tempRoot },
        modelExecutor: createWriteModelExecutor(firstFile, "hello") as never,
        runtimeConfig: {
          mode: "yolo",
          workingDirectory: tempRoot,
        },
        sessionId,
        sessionStore: store,
        skipUserConfig: true,
      });
      await firstApp.submitPrompt("create step1.txt");
      await firstApp.close?.();
      expect(await readFile(firstFile, "utf8")).toBe("hello");

      const resumedApp = await createZCodeApp({
        env: { ZCODE_STORAGE_DIR: tempRoot },
        modelExecutor: createWriteModelExecutor(secondFile, "world") as never,
        resume: true,
        runtimeConfig: {
          // headless 未显式传 --mode 时也会把默认 yolo 作为本次 invocation mode 传入。
          mode: "yolo",
          workingDirectory: tempRoot,
        },
        sessionId,
        sessionStore: store,
        skipUserConfig: true,
      });
      await resumedApp.submitPrompt("create step2.txt");

      expect(resumedApp.getMode()).toBe("yolo");
      expect(await readFile(secondFile, "utf8")).toBe("world");
      await resumedApp.close?.();
    } finally {
      store.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("hydrates persisted history when resuming a session in a fresh app", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-resume-history-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const store = createSqliteSessionStore({ dbPath });
    const sessionId = createSessionId("resume-history");
    let capturedMessages: Array<{ role: string; content: string }> = [];

    try {
      const firstApp = await createZCodeApp({
        env: {},
        modelExecutor: {
          async generateText() {
            return {
              text: "first answer",
              finishReason: "stop",
              usage: {
                inputTokens: 1,
                outputTokens: 2,
                totalTokens: 3,
              },
            };
          },
        } as never,
        runtimeConfig: {
          workingDirectory: tempRoot,
        },
        sessionId,
        sessionStore: store,
      });

      await firstApp.submitPrompt("first prompt");

      const secondApp = await createZCodeApp({
        env: {},
        modelExecutor: {
          async generateText(request: { messages: Array<{ role: string; content: string }> }) {
            capturedMessages = request.messages;
            return {
              text: "second answer",
              finishReason: "stop",
              usage: {
                inputTokens: 2,
                outputTokens: 3,
                totalTokens: 5,
              },
            };
          },
        } as never,
        resume: true,
        runtimeConfig: {
          workingDirectory: join(tempRoot, "different-cwd"),
        },
        sessionId,
        sessionStore: store,
      });

      const result = await secondApp.submitPrompt("second prompt");
      const storedMessages = await store.messages({ sessionID: sessionId });

      expect(result.response).toBe("second answer");
      expect(storedMessages).toHaveLength(4);
      expect(capturedMessages.map((message) => message.role)).toEqual([
        "system",
        "system",
        "system",
        "user",
        "user",
        "user",
        "assistant",
        "user",
      ]);
      expect(capturedMessages.map((message) => message.content)).toEqual([
        expect.stringContaining("You are ZCode"),
        // 修复原因：resume 使用现行 static # Harness + dynamic # Environment prompt 布局。
        expect.stringContaining("# Harness"),
        expect.stringContaining("# Environment"),
        expect.stringContaining("The following skills are available"),
        expect.stringContaining("<system-reminder>"),
        "first prompt",
        "first answer",
        "second prompt",
      ]);
    } finally {
      store.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("can explicitly hydrate a resumed app before the next prompt", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-explicit-resume-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const store = createSqliteSessionStore({ dbPath });
    const sessionId = createSessionId("explicit-resume");
    const liveEventTypes: string[] = [];
    let capturedMessages: Array<{ role: string; content: string }> = [];

    try {
      const firstApp = await createZCodeApp({
        env: {},
        modelExecutor: {
          async generateText() {
            return {
              text: "first answer",
              finishReason: "stop",
              usage: {
                inputTokens: 1,
                outputTokens: 2,
                totalTokens: 3,
              },
            };
          },
        } as never,
        runtimeConfig: {
          workingDirectory: tempRoot,
        },
        sessionId,
        sessionStore: store,
      });

      await firstApp.submitPrompt("first prompt");

      const secondApp = await createZCodeApp({
        env: {},
        modelExecutor: {
          async generateText(request: { messages: Array<{ role: string; content: string }> }) {
            capturedMessages = request.messages;
            return {
              text: "second answer",
              finishReason: "stop",
              usage: {
                inputTokens: 2,
                outputTokens: 3,
                totalTokens: 5,
              },
            };
          },
        } as never,
        resume: true,
        runtimeConfig: {
          workingDirectory: join(tempRoot, "different-cwd"),
        },
        sessionId,
        sessionStore: store,
      });

      const resume = await secondApp.resume({
        onEvent: (event) => {
          liveEventTypes.push(event.type);
        },
      });
      const result = await secondApp.submitPrompt("second prompt");

      expect(resume.messageCount).toBe(2);
      expect(resume.appliedMessageCount).toBe(2);
      expect(result.response).toBe("second answer");
      // 冷恢复会先补齐持久标题事件，再发布 SessionResumed。
      expect(liveEventTypes).toEqual([
        SessionEventType.SessionTitleUpdated,
        SessionEventType.SessionResumed,
      ]);
      expect(capturedMessages.map((message) => message.content)).toEqual([
        expect.stringContaining("You are ZCode"),
        expect.stringContaining("# Harness"),
        expect.stringContaining("# Communicating with the user"),
        expect.stringContaining("The following skills are available"),
        expect.stringContaining("<system-reminder>"),
        "first prompt",
        "first answer",
        "second prompt",
      ]);
    } finally {
      store.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("initializes the Bash shell snapshot before direct app prompt submission", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-direct-shell-snapshot-"));
    const shellDir = join(tempRoot, "bin");
    const zshPath = join(shellDir, "zsh");
    const store = createSqliteSessionStore({ dbPath: ":memory:" });
    let capturedMessages: Array<{ role: string; content: string }> = [];

    try {
      await mkdir(shellDir, { recursive: true });
      await writeFile(zshPath, "#!/bin/sh\n");
      await chmod(zshPath, 0o755);

      const app = await createZCodeApp({
        env: {
          PATH: shellDir,
          SHELL: join(shellDir, "fish"),
        },
        modelExecutor: {
          async generateText(request: { messages: Array<{ role: string; content: string }> }) {
            capturedMessages = request.messages;
            return {
              text: "answer",
              finishReason: "stop",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never,
        runtimeConfig: {
          workingDirectory: tempRoot,
        },
        sessionId: createSessionId("direct-shell-snapshot"),
        sessionStore: store,
      });

      await app.submitPrompt("first prompt");

      const providerText = capturedMessages.map((message) => message.content).join("\n");
      expect(providerText).toContain("- Shell: zsh");
      expect(providerText).not.toContain("- Shell: fish");
    } finally {
      store.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("initializes a direct app resume fallback before explicit hydration", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-direct-resume-shell-snapshot-"));
    const oldShellDir = join(tempRoot, "old-bin");
    const newShellDir = join(tempRoot, "new-bin");
    const oldZshPath = join(oldShellDir, "zsh");
    const newBashPath = join(newShellDir, "bash");
    const store = createSqliteSessionStore({ dbPath: ":memory:" });
    const sessionId = createSessionId("direct-resume-shell-snapshot");
    let capturedMessages: Array<{ role: string; content: unknown }> = [];

    try {
      await mkdir(oldShellDir, { recursive: true });
      await mkdir(newShellDir, { recursive: true });
      await writeFile(oldZshPath, "#!/bin/sh\n");
      await writeFile(newBashPath, "#!/bin/sh\n");
      await chmod(oldZshPath, 0o755);
      await chmod(newBashPath, 0o755);

      const firstApp = await createZCodeApp({
        env: {
          PATH: oldShellDir,
          SHELL: join(oldShellDir, "fish"),
        },
        modelExecutor: {
          async generateText() {
            return {
              text: "first answer",
              finishReason: "stop",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never,
        runtimeConfig: {
          workingDirectory: tempRoot,
        },
        sessionId,
        sessionStore: store,
      });

      await firstApp.submitPrompt("first prompt");
      await rm(oldZshPath, { force: true });

      const secondApp = await createZCodeApp({
        env: {
          PATH: newShellDir,
          SHELL: newBashPath,
        },
        modelExecutor: {
          async generateText(request: { messages: Array<{ role: string; content: unknown }> }) {
            capturedMessages = request.messages;
            return {
              text: "second answer",
              finishReason: "stop",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never,
        resume: true,
        runtimeConfig: {
          workingDirectory: tempRoot,
        },
        sessionId,
        sessionStore: store,
      });

      await secondApp.resume();
      await secondApp.submitPrompt("second prompt");

      const providerText = JSON.stringify(capturedMessages);
      // 修复原因：shell 变化提醒已统一为 buildShellEnvironmentResumeNotice 的标准文案。
      expect(providerText).toContain("The Bash tool shell is bash.");
      expect(providerText).not.toContain("The Bash tool shell is fish.");
    } finally {
      store.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("projects persisted user and assistant transcript rows for resume UIs", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-resume-transcript-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const store = createSqliteSessionStore({ dbPath });
    const sessionId = createSessionId("resume-transcript");

    try {
      const firstApp = await createZCodeApp({
        env: {},
        modelExecutor: {
          async generateText() {
            return {
              text: "first answer",
              finishReason: "stop",
              usage: {
                inputTokens: 1,
                outputTokens: 2,
                totalTokens: 3,
              },
            };
          },
        } as never,
        runtimeConfig: {
          workingDirectory: tempRoot,
        },
        sessionId,
        sessionStore: store,
      });

      await firstApp.submitPrompt("first prompt");

      const resumedApp = await createZCodeApp({
        env: {},
        modelExecutor: {
          async generateText() {
            return {
              text: "unused",
              finishReason: "stop",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never,
        resume: true,
        runtimeConfig: {
          workingDirectory: join(tempRoot, "other-cwd"),
        },
        sessionId,
        sessionStore: store,
      });

      await resumedApp.resume();
      await expect(resumedApp.loadSessionTranscript()).resolves.toEqual([
        {
          content: "first prompt",
          role: "user",
        },
        {
          content: "first answer",
          role: "agent",
        },
      ]);
    } finally {
      store.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("preserves the original git snapshot across resume so later repository changes do not rewrite the cached system prompt", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-resume-git-snapshot-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const store = createSqliteSessionStore({ dbPath });
    const sessionId = createSessionId("resume-git-snapshot");
    let capturedMessages: Array<{ role: string; content: string }> = [];

    // 模拟历史存储的额外字段；当前 EnvInfo 契约不再声明执行模型。
    const firstEnvInfo: EnvInfo & { currentModel: string } = {
      cwd: tempRoot,
      platform: "darwin",
      shell: "zsh",
      osVersion: "Darwin 25.4.0",
      nodeVersion: "v24.14.0",
      currentModel: "legacy/persisted-model",
      isGitRepository: true,
      gitBranch: "feature/original",
      gitMainBranch: "main",
      gitUser: "ZCode Tester <tester@example.com>",
      gitStatus: "dirty",
      gitStatusLines: [" M first.ts"],
      recentCommits: ["abc123 first commit"],
    };
    const secondEnvInfo: EnvInfo = {
      ...firstEnvInfo,
      cwd: join(tempRoot, "different-cwd"),
      gitStatusLines: [" M second.ts"],
      recentCommits: ["def456 second commit"],
    };

    try {
      const firstApp = await createZCodeApp({
        env: {},
        modelExecutor: {
          async generateText() {
            return {
              text: "first answer",
              finishReason: "stop",
              usage: {
                inputTokens: 1,
                outputTokens: 2,
                totalTokens: 3,
              },
            };
          },
        } as never,
        runtimeConfig: {
          envInfo: firstEnvInfo,
          workingDirectory: tempRoot,
        },
        sessionId,
        sessionStore: store,
      });

      await firstApp.submitPrompt("first prompt");

      const secondApp = await createZCodeApp({
        env: {},
        modelExecutor: {
          async generateText(request: { messages: Array<{ role: string; content: string }> }) {
            capturedMessages = request.messages;
            return {
              text: "second answer",
              finishReason: "stop",
              usage: {
                inputTokens: 2,
                outputTokens: 3,
                totalTokens: 5,
              },
            };
          },
        } as never,
        resume: true,
        runtimeConfig: {
          envInfo: secondEnvInfo,
          modelSelection: {
            providerId: "openai",
            modelId: "gpt-5",
            options: { reasoningLevel: "high" },
          },
          workingDirectory: join(tempRoot, "different-cwd"),
        },
        sessionId,
        sessionStore: store,
      });

      await secondApp.submitPrompt("second prompt");

      const dynamicSystem = capturedMessages[2]?.content ?? "";
      // 冷恢复保留首次会话保存的模型，不用启动参数覆盖；模型说明随实际恢复的 Model 渲染。
      expect(dynamicSystem).toContain("- You are powered by the model named zai/glm-4.6.");
      expect(dynamicSystem).not.toContain("legacy/persisted-model");
      // 修复原因：原始 git snapshot 现在与环境信息一起保存在 dynamic system[2]。
      expect(dynamicSystem).toContain("gitStatus:");
      expect(dynamicSystem).toContain("feature/original");
      expect(dynamicSystem).toContain(" M first.ts");
      expect(dynamicSystem).toContain("abc123 first commit");
      expect(dynamicSystem).not.toContain(" M second.ts");
      expect(dynamicSystem).not.toContain("def456 second commit");
    } finally {
      store.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

interface LogEntry {
  event?: string;
  context?: Record<string, unknown>;
}

interface AiSdkWarningGlobal {
  AI_SDK_LOG_WARNINGS?: false | ((options: Record<string, unknown>) => void);
}

async function createProtocolProviderEnv(root: string): Promise<Record<string, string>> {
  const zcodeBuiltinFilePath = join(root, "zcode-builtin.json");
  const personalFilePath = join(root, "provider-personal.json");
  const emptyBuiltinRelease = JSON.stringify({
    // 此处测试启动/存储顺序，不测试旧版 Release 迁移；使用当前正式结构。
    schemaVersion: 3,
    revision: 1,
    config: {
      providers: {},
      providerTemplates: {},
      modelConfigRules: { matchRules: [], templateModelRules: [], providerModelRules: [] },
    },
  });
  const emptyPersonalConfig = JSON.stringify({
    schemaVersion: 1,
    providers: {},
    modelConfigRules: [],
  });
  await Promise.all([
    writeFile(zcodeBuiltinFilePath, emptyBuiltinRelease),
    writeFile(personalFilePath, emptyPersonalConfig),
  ]);
  return createNodeProviderRuntimePathEnv({ zcodeBuiltinFilePath, personalFilePath });
}

async function readLogEntries(logDir: string): Promise<LogEntry[]> {
  const files = await readdir(logDir);
  const entries: LogEntry[] = [];

  for (const file of files) {
    const content = await readFile(join(logDir, file), "utf8");
    for (const line of content.trim().split("\n")) {
      if (line) entries.push(JSON.parse(line) as LogEntry);
    }
  }

  return entries;
}

function uniqueContextValues(entries: LogEntry[], key: string): Set<unknown> {
  return new Set(
    entries.map((entry) => entry.context?.[key]).filter((value) => value !== undefined),
  );
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolveDeferred: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    resolveDeferred = resolve;
  });
  return {
    promise,
    resolve: resolveDeferred,
  };
}

function createNeverEndingReadable(): NodeJS.ReadableStream {
  return {
    off: () => createNeverEndingReadable(),
    once: () => createNeverEndingReadable(),
  } as unknown as NodeJS.ReadableStream;
}

function createClosableReadable(): NodeJS.ReadableStream {
  return Readable.from([]);
}

function testProjectIdFromDirectory(directory: string) {
  return createProjectId(
    directory
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "default",
  );
}

function createRecordingLoggerFactory(): LoggerFactory & {
  events: string[];
  scheduleCalls: number;
  scheduleLogRetentionCleanup(options?: { logger?: Logger }): void;
} {
  const events: string[] = [];
  let scheduleCalls = 0;

  const loggerFor = (context: LogContext = {}): Logger => ({
    child(childContext) {
      return loggerFor({ ...context, ...childContext });
    },
    debug(_message, logContext) {
      recordEvent(events, context, logContext);
    },
    error(_message, _error, logContext) {
      recordEvent(events, context, logContext);
    },
    info(_message, logContext) {
      recordEvent(events, context, logContext);
    },
    warn(_message, logContext) {
      recordEvent(events, context, logContext);
    },
  });

  return {
    createLogger: () => loggerFor(),
    events,
    get scheduleCalls() {
      return scheduleCalls;
    },
    scheduleLogRetentionCleanup() {
      scheduleCalls += 1;
      events.push("scheduleLogRetentionCleanup");
    },
    setLevel: () => {},
    withContext: (context) => loggerFor(context),
  };
}

function recordEvent(events: string[], baseContext: LogContext, context?: LogContext): void {
  const event = context?.event ?? baseContext.event;
  if (typeof event === "string") {
    events.push(event);
  }
}

function createMemoryWritable(): NodeJS.WritableStream & { output(): string } {
  let output = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
      callback();
    },
  }) as NodeJS.WritableStream & { output(): string };
  stream.output = () => output;
  return stream;
}
