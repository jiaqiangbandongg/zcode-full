import { channelReplyHostRequestSchema, type ChannelReplyHostRequest } from "@zcode/shared";
// v4 conversation 通道 host 转发面测试（M3 竖切，docs/v4-refactor/01-topology §host 通道层）。
// 验证 host 只做透传：subscribe/unsubscribe/command 转发给 CLI v4 方法，
// v4/conversation/frame 通知按 workspace fan-out 给 onDynamicConversationFrame 订阅者。
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TopicWireFrameAssembler,
  conversationTopicFrameSchema,
  type ConversationTopicWireCandidate,
  type ConversationTopicWireFrame,
  type SessionsIndexTopicWireCandidate,
  type WorkspaceConfigTopicWireCandidate,
} from "@zcode/shared/zcode-protocol-v4";
import { createZCodeAgentConnectionScope } from "../src/zcode-agent/zcodeAgentConnectionScope.js";
import {
  createZCodeAgentService,
  supportsLegacyRemoteTaskAllowlist,
} from "../src/zcode-agent/zcodeAgentService.js";
import { setDataBaseDir } from "../src/paths.js";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";

// 最小 v4 fake agent：
// - v4/conversation/subscribe → 一次 stdout.write 连续写 ACK-only response + initial notification；
// - v4/conversation/unsubscribe → 返回 {}；
// - v4/command → 返回 CommandAck accepted。
// 所有入站请求写入 logPath 供断言转发参数。
const V4_FAKE_AGENT = `
const fs = require("node:fs");
const logPath = process.argv[2];
let buf = "";
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (logPath && msg.method) fs.appendFileSync(logPath, line + "\\n");
    if (msg.method === "session/debug" && msg.id !== undefined) {
      send({ id: msg.id, result: { sessionId: msg.params.sessionId, rounds: [], networkEntries: [], cache: null } });
      continue;
    }
    if (msg.method === "v4/conversation/backgroundBashOutput" && msg.id !== undefined) {
      if (msg.params.workId === "unsupported") send({ id: msg.id, error: { code: -32601, message: "Method not found" } });
      else send({ id: msg.id, result: { kind: "unavailable", workId: msg.params.workId } });
      continue;
    }
    if (msg.method === "v4/conversation/subscribe" && msg.params.topic.endsWith("/channel-reply-source")) {
      send({ id: "reverse-reply", method: "bot/channel/reply", trace: { traceId: "trace-native" }, params: { taskId: "channel-reply-source", inputId: "input-a", toolCallId: "call-a", parts: [{type:"mention",refId:"m1"}] } });
    }
    if (msg.method === "v4/conversation/subscribe" && msg.params.topic.endsWith("/topic-resource-source")) {
      send({ id: "reverse-resource", method: "topic/resource/read", params: { requestId: "resource-a", taskId: "topic-resource-source", inputId: "input-a", authorizationId: "auth-a", messageId: "message-a", resourceIndex: 0 } });
    }
    if (msg.method === "v4/conversation/subscribe" && msg.id !== undefined) {
      const response = {
        id: msg.id,
        result: {
          ack: { subscriptionId: "sub-1", mode: "snapshot", logEpoch: "epoch-1" },
        },
      };
      const route = {
        wireVersion: 3,
        logicalFrameOrdinal: 1,
        topic: msg.params.topic,
        subscriptionId: "sub-1",
        deliveryKind: "online",
      };
      let params;
      if (msg.params.topic.endsWith("/missing-delivery-kind")) {
        params = {
          ...route,
          deliveryKind: undefined,
          kind: "complete",
          logicalFrameId: "logical-missing-delivery-kind",
          frame: {
            topic: msg.params.topic,
            subscriptionId: "sub-1",
            fromSeq: 0,
            toSeq: 0,
            sentAt: 1700000000000,
            payload: { kind: "deltas", deltas: [] },
          },
        };
      } else if (msg.params.topic.endsWith("/invalid-delivery-kind")) {
        params = {
          ...route,
          deliveryKind: "guessed-recovery",
          kind: "complete",
          logicalFrameId: "logical-invalid-delivery-kind",
          frame: {
            topic: msg.params.topic,
            subscriptionId: "sub-1",
            fromSeq: 0,
            toSeq: 0,
            sentAt: 1700000000000,
            payload: { kind: "deltas", deltas: [] },
          },
        };
      } else if (msg.params.topic.endsWith("/invalid-base64")) {
        params = {
          ...route,
          wireVersion: 3,
          kind: "fragment",
          logicalFrameId: "logical-invalid",
          fragmentIndex: 0,
          fragmentCount: 1,
          logicalBytes: 1,
          checksum: { algorithm: "crc32", value: "00000000" },
          dataBase64: "%%%="
        };
      } else if (msg.params.topic.endsWith("/fragment-count-1025")) {
        params = {
          ...route,
          kind: "fragment",
          logicalFrameId: "logical-too-many-fragments",
          fragmentIndex: 0,
          fragmentCount: 1025,
          logicalBytes: 1025,
          checksum: { algorithm: "crc32", value: "00000000" },
          dataBase64: "AA=="
        };
      } else if (msg.params.topic.endsWith("/missing-checksum")) {
        params = {
          ...route,
          kind: "fragment",
          logicalFrameId: "logical-missing-checksum",
          fragmentIndex: 0,
          fragmentCount: 1,
          logicalBytes: 1,
          dataBase64: "AA=="
        };
      } else if (msg.params.topic.endsWith("/checksum-value-number")) {
        params = {
          ...route,
          kind: "fragment",
          logicalFrameId: "logical-checksum-value-number",
          fragmentIndex: 0,
          fragmentCount: 1,
          logicalBytes: 1,
          checksum: { algorithm: "crc32", value: 1 },
          dataBase64: "AA=="
        };
      } else if (msg.params.topic.endsWith("/data-base64-number")) {
        params = {
          ...route,
          kind: "fragment",
          logicalFrameId: "logical-data-base64-number",
          fragmentIndex: 0,
          fragmentCount: 1,
          logicalBytes: 1,
          checksum: { algorithm: "crc32", value: "00000000" },
          dataBase64: 1
        };
      } else if (msg.params.topic.endsWith("/extra-inner-field")) {
        params = {
          ...route,
          kind: "fragment",
          logicalFrameId: "logical-extra-inner-field",
          fragmentIndex: 0,
          fragmentCount: 1,
          logicalBytes: 1,
          checksum: { algorithm: "crc32", value: "00000000" },
          dataBase64: "AA==",
          unexpected: true
        };
      } else if (msg.params.topic.endsWith("/invalid-complete")) {
        params = {
          ...route,
          kind: "complete",
          logicalFrameId: "logical-invalid-complete",
          frame: { topic: msg.params.topic, subscriptionId: "sub-1" },
        };
      } else if (msg.params.topic.endsWith("/invalid-checksum-algorithm")) {
        params = {
          ...route,
          kind: "fragment",
          logicalFrameId: "logical-invalid-checksum-algorithm",
          fragmentIndex: 0,
          fragmentCount: 1,
          logicalBytes: 1,
          checksum: { algorithm: "sha256", value: "00000000" },
          dataBase64: "AA=="
        };
      } else if (msg.params.topic.endsWith("/invalid-checksum-value")) {
        params = {
          ...route,
          kind: "fragment",
          logicalFrameId: "logical-invalid-checksum-value",
          fragmentIndex: 0,
          fragmentCount: 1,
          logicalBytes: 1,
          checksum: { algorithm: "crc32", value: "not-crc32" },
          dataBase64: "AA=="
        };
      } else {
        params = {
          ...route,
          kind: "complete",
          logicalFrameId: "logical-initial",
          frame: {
            topic: msg.params.topic,
            subscriptionId: "sub-1",
            fromSeq: 0,
            toSeq: 0,
            sentAt: 1700000000000,
            payload: { kind: "deltas", deltas: [] },
          },
        };
      }
      const initial = {
        method: "v4/conversation/frame",
        params,
      };
      process.stdout.write(JSON.stringify(response) + "\\n" + JSON.stringify(initial) + "\\n");
    }
    if (msg.method === "v4/conversation/unsubscribe" && msg.id !== undefined) {
      const reply = () => send({ id: msg.id, result: {} });
      if (msg.params.topic.endsWith("/delayed-unsubscribe")) setTimeout(reply, 200);
      else reply();
    }
    if (msg.method === "v4/connection/flow" && msg.id !== undefined) {
      send({ id: msg.id, result: {} });
    }
    if (msg.method === "v4/attachment/begin" && msg.id !== undefined) {
      send({ id: msg.id, result: { uploadId: msg.params.uploadId, state: "staging", nextChunkIndex: 0 } });
    }
    if (msg.method === "v4/attachment/chunk" && msg.id !== undefined) {
      send({ id: msg.id, result: { uploadId: msg.params.uploadId, nextChunkIndex: msg.params.chunkIndex + 1 } });
    }
    if (msg.method === "v4/attachment/commit" && msg.id !== undefined) {
      send({ id: msg.id, result: { ref: "zcode-artifact://upload/one" } });
    }
    if (msg.method === "v4/attachment/abort" && msg.id !== undefined) {
      send({ id: msg.id, result: {} });
    }
    if (msg.method === "v4/attachment/previewSource" && msg.id !== undefined) {
      send({ id: msg.id, result: {
        kind: "local_path",
        path: "/tmp/.zcode/video-cache/demo.mp4",
        mediaType: "video/mp4"
      } });
    }
    if (msg.method === "v4/conversation/resync" && msg.id !== undefined) {
      const response = {
        id: msg.id,
        result: {
          ack: {
            subscriptionId: msg.params.subscriptionId,
            mode: msg.params.forceSnapshot ? "snapshot" : "resume",
            logEpoch: "epoch-1",
          },
        },
      };
      const recovery = {
        method: "v4/conversation/frame",
        params: {
          wireVersion: 3,
          kind: "complete",
          logicalFrameId: "logical-recovery",
          logicalFrameOrdinal: 2,
          topic: msg.params.topic,
          subscriptionId: msg.params.subscriptionId,
          deliveryKind: "recovery",
          frame: {
            topic: msg.params.topic,
            subscriptionId: msg.params.subscriptionId,
            fromSeq: 0,
            toSeq: 0,
            sentAt: 1700000000001,
            payload: { kind: "deltas", deltas: [] },
          },
        },
      };
      const reply = () =>
        process.stdout.write(JSON.stringify(response) + "\\n" + JSON.stringify(recovery) + "\\n");
      if (msg.params.topic.endsWith("/delayed-resync")) setTimeout(reply, 200);
      else reply();
    }
    if (msg.method === "v4/command" && msg.id !== undefined) {
      const status = "accepted";
      const acceptedInput = {
        delivery: "startNow",
        inputId: msg.params.commandId,
        messageId: "msg-" + msg.params.commandId,
      };
      const createSessionResult = msg.params.type === "createSession"
        ? { result: { type: "createSession", sessionId: "created-session", input: acceptedInput } }
        : msg.params.type === "sendText"
          ? { result: { type: "inputAccepted", ...acceptedInput } }
          : {};
      send({
        id: msg.id,
        result: {
          commandId: msg.params.commandId,
          status,
          revisionAtDecision: 3,
          ...createSessionResult,
        },
      });
    }
    if (msg.method === "v4/commands/query" && msg.id !== undefined) {
      send({
        id: msg.id,
        result: {
          results: msg.params.commands.map((key) => ({ key, result: "unknown" })),
        },
      });
    }
  }
});
`;

function readRequests(logPath: string): Array<{ method: string; params: Record<string, unknown> }> {
  if (!existsSync(logPath)) {
    return [];
  }
  return readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
}

describe("zcodeAgentService v4 conversation channel", () => {
  const createdDirs: string[] = [];

  afterEach(() => {
    setDataBaseDir(null);
    for (const dir of createdDirs.splice(0).reverse()) {
      // 根因：Windows 不允许删除仍有打开句柄的目录，而 runtime/子进程与 watcher 的句柄
      // 是异步收口的；`force: true` 只吞 ENOENT，不做任何重试。于是 afterEach 稳定抛
      // `EPERM, Permission denied: \\?\C:\...\Temp\zcode-agent-v4-xxxx`，把已经通过断言
      // 的用例判成失败（POSIX 允许删除仍被打开的 inode，所以只在 Windows 上出现）。
      // 先用 rm 自带的有界重试等句柄释放；真的等不到也不该让清理决定用例成败，
      // 临时目录由操作系统回收。
      try {
        rmSync(dir, {
          recursive: true,
          force: true,
          maxRetries: 20,
          retryDelay: 100,
        });
      } catch {
        /* 清理失败不影响断言结论，交给操作系统回收临时目录。 */
      }
    }
  });

  function setupService(
    options: {
      providerReady?: boolean;
      authorizeLocalMediaPreviewPath?: (path: string) => Promise<string>;
      channelReplyExecutor?: NonNullable<
        Parameters<typeof createZCodeAgentService>[0]
      >["channelReplyExecutor"];
      topicResourceExecutor?: NonNullable<
        Parameters<typeof createZCodeAgentService>[0]
      >["topicResourceExecutor"];
    } = {},
  ) {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-v4-"));
    createdDirs.push(workspacePath);
    setDataBaseDir(workspacePath);
    const scriptPath = join(workspacePath, "v4-fake-agent.cjs");
    const logPath = join(workspacePath, "protocol.log");
    writeFileSync(scriptPath, V4_FAKE_AGENT);
    const commandResolver = vi.fn(() => ({
      command: process.execPath,
      args: [scriptPath, logPath],
    }));
    const service = createZCodeAgentService({
      commandResolver,
      topicResourceExecutor: options.topicResourceExecutor,
      channelReplyExecutor: options.channelReplyExecutor,
      authorizeLocalMediaPreviewPath: options.authorizeLocalMediaPreviewPath,
      modelSelectionReadinessSource: {
        async getView() {
          return {
            revision: 1,
            providers:
              options.providerReady === false
                ? []
                : [
                    {
                      providerId: "glm",
                      config: {
                        kind: "api" as const,
                        api: {
                          type: "openai-chat-completions" as const,
                          baseUrl: "https://provider.test/v1",
                        },
                        models: ["glm-4.6"],
                      },
                      models: [{ modelId: "glm-4.6", config: {} }],
                    },
                  ],
          };
        },
      },
    });
    return { service, workspacePath, logPath, commandResolver };
  }

  it.each([false, true])(
    "projects only channel reply scope from a live V4 connection (remote=%s)",
    async (remote) => {
      const reply = vi.fn(async (value: ChannelReplyHostRequest) => {
        // 与实际 Host executor 一样执行严格校验，不能用宽松 spy 掩盖额外连接字段。
        channelReplyHostRequestSchema.parse(value);
        return { status: "sent" as const, deliveryId: "delivery", providerMessageId: "om_sent" };
      });
      const { service, workspacePath } = setupService({ channelReplyExecutor: reply });
      const scope = remote
        ? { workspaceIdentity: "ssh://host/work", remoteSessionId: "logical-session" }
        : {};
      const target = {
        workspacePath,
        ...scope,
        sessionId: "channel-reply-source",
        envelope: { requestId: "transport-request" },
        __zcodeTrustedV4Connection: { connectionId: "test-connection" },
      };
      try {
        await service.subscribeConversationV4(target);
        await vi.waitFor(() => expect(reply).toHaveBeenCalled());
        const received = reply.mock.calls[0]![0];
        expect(() => channelReplyHostRequestSchema.parse(received)).not.toThrow();
        expect(received).toEqual({
          workspacePath,
          workspaceIdentity: scope.workspaceIdentity,
          remoteSessionId: scope.remoteSessionId,
          taskId: "channel-reply-source",
          inputId: "input-a",
          toolCallId: "call-a",
          trace: { traceId: "trace-native" },
          parts: [{ type: "mention", refId: "m1" }],
        });
      } finally {
        await service.disposeAllAndWait();
      }
    },
  );

  it("carries the active remote session on reverse resource requests after cold warmup", async () => {
    const read = vi.fn(async () => {
      throw new Error("download intentionally stopped after route capture");
    });
    const { service, workspacePath } = setupService({ topicResourceExecutor: read });
    try {
      await service.subscribeConversationV4({
        workspacePath,
        workspaceIdentity: "ssh://host/work",
        sessionId: "warmup",
      });
      await service.subscribeConversationV4({
        workspacePath,
        workspaceIdentity: "ssh://host/work",
        remoteSessionId: "logical-session",
        sessionId: "topic-resource-source",
      });
      await vi.waitFor(() =>
        expect(read).toHaveBeenCalledWith(
          expect.objectContaining({
            workspaceIdentity: "ssh://host/work",
            remoteSessionId: "logical-session",
            taskId: "topic-resource-source",
          }),
          expect.any(AbortSignal),
        ),
      );
    } finally {
      await service.disposeAllAndWait();
    }
  });

  it.each(["desktop-continuous", "web-remote-replayable"] as const)(
    "session debug remains read-only and workspace-scoped on %s",
    async (clientMode) => {
      const { service, workspacePath, commandResolver, logPath } = setupService();
      const scope = createZCodeAgentConnectionScope(service, { connectionId: "debug", clientMode });
      const target = {
        workspacePath,
        workspaceIdentity: "ssh://debug/workspace",
        sessionId: "debug-session",
      };
      try {
        await expect(scope.service.readSessionDebug(target)).rejects.toThrow();
        expect(commandResolver).not.toHaveBeenCalled();
        await scope.service.helloConversationV4();
        await scope.service.initializeConversationV4({
          kind: "clientHello",
          protocolVersion: 3,
          clientId: "debug",
          appVersion: "test",
        });
        await scope.service.subscribeConversationV4(target);
        expect(await scope.service.readSessionDebug(target)).toEqual({
          sessionId: "debug-session",
          rounds: [],
          networkEntries: [],
          cache: null,
        });
        const lines = readFileSync(logPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(
          lines.filter((line) => line.method === "session/debug").map((line) => line.params),
        ).toEqual([{ sessionId: "debug-session" }]);
        expect(
          lines.some(
            (line) => line.method === "session/resume" || line.method === "session/subscribe",
          ),
        ).toBe(false);
      } finally {
        scope.dispose();
        await service.disposeAllAndWait();
      }
    },
  );

  it.each([undefined, { text: "Guarded work" }, { text: "Guarded work", mode: "guarded" }])(
    "Guarded create forwards the original payload once (firstInput=%j)",
    async (firstInput) => {
      const { service, workspacePath, logPath } = setupService();
      try {
        const payload = {
          workspaceId: workspacePath,
          config: { mode: "guarded" },
          ...(firstInput ? { firstInput } : {}),
        };
        const ack = await service.sendConversationCommandV4({
          workspacePath,
          envelope: {
            commandId: "guarded-create",
            clientId: "guarded-client",
            issuedAt: 1,
            sessionId: null,
            type: "createSession",
            payload,
          },
        });
        expect(ack).toMatchObject({
          status: "accepted",
          result: { type: "createSession", sessionId: "created-session" },
        });
        const commands = readRequests(logPath).filter((item) => item.method === "v4/command");
        // 根因：为不存在的版本错配补写 mode、补发无 revision 的模式命令，改变了原创建合同。
        expect(commands).toHaveLength(1);
        expect(commands[0]?.params.type).toBe("createSession");
        expect(commands[0]?.params.payload).toEqual(payload);
      } finally {
        await service.disposeAllAndWait();
      }
    },
  );

  it("keeps history topics readable without letting the active client bypass provider readiness", async () => {
    const { service, workspacePath, logPath, commandResolver } = setupService({
      providerReady: false,
    });
    try {
      const sessionsIndex = await service.subscribeSessionsIndexV4({ workspacePath });
      const conversation = await service.subscribeConversationV4({
        workspacePath,
        sessionId: "persisted-session",
      });

      expect(sessionsIndex.ack.subscriptionId).toBe("sub-1");
      expect(conversation.ack.subscriptionId).toBe("sub-1");
      expect(conversation.ack.openTiming).toMatchObject({
        version: 1,
        hostPrepareMs: expect.any(Number),
        providerRegistrySyncMs: expect.any(Number),
        taskMetaReadMs: expect.any(Number),
        cliRequestMs: expect.any(Number),
      });
      expect(commandResolver).toHaveBeenCalledTimes(1);

      // 修复原因：只读 topic 已经登记 active client，旧 fast path 会直接返回它并绕过
      // provider/model 门禁。createSession 必须仍在写入协议前确定性拒绝。
      await expect(service.createSession({ workspacePath })).rejects.toMatchObject({
        code: "ZCODE_AGENT_PROVIDER_NOT_READY",
        data: expect.objectContaining({ reason: "provider_not_ready" }),
      });

      const requests = readRequests(logPath);
      expect(
        requests
          .filter((entry) => entry.method === "v4/conversation/subscribe")
          .map((entry) => entry.params.topic),
      ).toEqual([`sessions-index/${workspacePath}`, "conversation/persisted-session"]);
      expect(requests.some((entry) => entry.method === "session/create")).toBe(false);
    } finally {
      await service.disposeAllAndWait();
    }
  });

  it("uses the registry view only as a readiness gate for a cold conversation subscription", async () => {
    const { service, workspacePath, logPath } = setupService();
    try {
      await service.subscribeConversationV4({
        workspacePath,
        sessionId: "cold-registry-session",
      });

      // Worker 已经持有进程级 Registry；Host 读取 Registry View 只用于启动门禁，
      // 不能把完整 Registry 下发成另一份执行事实源。
      expect(readRequests(logPath).map((entry) => entry.method)).toEqual([
        "v4/conversation/subscribe",
      ]);
      expect(
        readRequests(logPath).find((entry) => entry.method === "v4/conversation/subscribe")?.params,
      ).toMatchObject({
        workspace: {
          workspaceKey: workspacePath,
          workspacePath,
        },
      });
    } finally {
      await service.disposeAllAndWait();
    }
  });

  it.each(["desktop-continuous", "web-remote-replayable"] as const)(
    "background Bash query stays existing-only on %s",
    async (clientMode) => {
      const { service, workspacePath, commandResolver, logPath } = setupService();
      const scope = createZCodeAgentConnectionScope(service, {
        connectionId: "bash-query",
        clientMode,
      });
      const target = {
        workspacePath,
        workspaceIdentity: "ssh://bash-query/workspace",
        sessionId: "child",
        workId: "work",
      };
      try {
        await scope.service.helloConversationV4();
        await scope.service.initializeConversationV4({
          kind: "clientHello",
          protocolVersion: 3,
          clientId: "bash-query",
          appVersion: "test",
        });
        expect(await scope.service.backgroundBashOutputV4(target)).toEqual({
          kind: "unavailable",
          workId: "work",
        });
        expect(commandResolver).not.toHaveBeenCalled();
        await scope.service.subscribeConversationV4(target);
        expect(await scope.service.backgroundBashOutputV4(target)).toEqual({
          kind: "unavailable",
          workId: "work",
        });
        expect(commandResolver).toHaveBeenCalledTimes(1);
        const requests = readRequests(logPath);
        expect(
          requests
            .filter((entry) => entry.method === "v4/conversation/backgroundBashOutput")
            .map((entry) => entry.params),
        ).toEqual([{ sessionId: "child", workId: "work" }]);
        expect(requests.some((entry) => entry.method === "v4/command")).toBe(false);
        expect(
          await scope.service.backgroundBashOutputV4({ ...target, workId: "unsupported" }),
        ).toEqual({ kind: "unsupported", workId: "unsupported" });
      } finally {
        scope.dispose();
        await service.disposeAllAndWait();
      }
    },
  );

  it("existing-only subscriptions stay dormant until another operation starts the runtime", async () => {
    const { service, workspacePath, commandResolver } = setupService();
    const lifecycle: Array<{ state: "available" | "unavailable"; generation: number }> = [];
    const disposable = service.onAgentRuntimeLifecycle?.((event) => {
      lifecycle.push({
        state: event.state,
        generation: event.runtimeIdentity.generation,
      });
    });
    try {
      await expect(
        service.subscribeSessionsIndexV4({
          workspacePath,
          runtimePolicy: "existing-only",
        }),
      ).rejects.toMatchObject({ code: "ZCODE_AGENT_RUNTIME_UNAVAILABLE" });
      expect(commandResolver).not.toHaveBeenCalled();
      expect(lifecycle).toEqual([]);

      await service.subscribeConversationV4({
        workspacePath,
        sessionId: "explicit-user-session",
      });
      await service.subscribeSessionsIndexV4({
        workspacePath,
        runtimePolicy: "existing-only",
      });

      expect(commandResolver).toHaveBeenCalledTimes(1);
      expect(lifecycle).toEqual([{ state: "available", generation: 1 }]);

      await service.disposeWorkspace({ workspacePath });
      expect(lifecycle).toEqual([
        { state: "available", generation: 1 },
        { state: "unavailable", generation: 1 },
      ]);
    } finally {
      disposable?.dispose();
      await service.disposeAllAndWait();
    }
  });

  // `workflowRunDeltas` 与 `clientMode` 同族（10 §3.1）：可信 host 从连接的 clientHello 注入，
  // UI 面的 subscribe 入参碰不到它——一个客户端认不认得 `workflowRun.*` 增量是**连接**的事实。
  it.each([true, false])(
    "subscribe 的 workflowRunDeltas 只由 clientHello 声明决定（declared=%s）",
    async (declared) => {
      const { service, workspacePath, logPath } = setupService();
      const scope = createZCodeAgentConnectionScope(service, {
        connectionId: "workflow-run-deltas",
        clientMode: "desktop-continuous",
      });
      try {
        const hello = await scope.service.helloConversationV4();
        expect(hello.capabilities.workflowRunDeltas).toBe(true);
        await scope.service.initializeConversationV4({
          kind: "clientHello",
          protocolVersion: 3,
          clientId: "workflow-run-deltas",
          appVersion: "test",
          ...(declared ? { capabilities: { workflowRunDeltas: true } } : {}),
        });
        await scope.service.subscribeConversationV4({
          workspacePath,
          sessionId: "workflow-run-deltas-session",
          // 调用方自报的同名字段：必须被可信值整个顶掉，两种声明下都不能生效。
          workflowRunDeltas: !declared,
        } as never);

        const params = readRequests(logPath).find(
          (entry) => entry.method === "v4/conversation/subscribe",
        )?.params;
        if (declared) {
          expect(params).toMatchObject({ workflowRunDeltas: true });
        } else {
          expect(params).not.toHaveProperty("workflowRunDeltas");
        }
      } finally {
        scope.dispose();
        await service.disposeAllAndWait();
      }
    },
  );

  it("forwards task-local thought only as a V4 cold-resume hint", async () => {
    const { service, workspacePath, logPath } = setupService();
    const repo = new TaskIndexRepo();
    try {
      await repo.syncTaskMeta({
        meta: {
          taskId: "persisted-thought-session",
          traceId: "trace-persisted-thought-session",
          title: "persisted thought session",
          workspacePath,
          createdAt: 1,
          updatedAt: 2,
          mode: "build",
          provider: "glm",
          model: "glm/GLM-5.2",
          thoughtLevel: "max",
        },
      });

      await service.subscribeConversationV4({
        workspacePath,
        sessionId: "persisted-thought-session",
      });

      const request = readRequests(logPath).find(
        (entry) => entry.method === "v4/conversation/subscribe",
      );
      expect(request?.params).toMatchObject({
        topic: "conversation/persisted-thought-session",
        clientMode: "desktop-continuous",
        resumeThoughtLevel: "max",
      });
    } finally {
      repo.close();
      await service.disposeAllAndWait();
    }
  });

  it("forwards trusted continuous connection context and fans out frames per workspace", async () => {
    const { service, workspacePath, logPath } = setupService();
    try {
      const frames: ConversationTopicWireFrame[] = [];
      const disposable = service.onDynamicConversationFrame({ workspacePath })((frame) => {
        frames.push(frame);
      });

      const hello = await service.helloConversationV4();
      await service.initializeConversationV4({
        kind: "clientHello",
        protocolVersion: 3,
        clientId: "client-1",
        appVersion: "4.0.0",
      });
      expect(hello).toMatchObject({
        clientMode: "desktop-continuous",
        deliveryProfile: "continuous",
      });

      const result = await service.subscribeConversationV4({
        workspacePath,
        sessionId: "s1",
      });
      expect(result.ack).toMatchObject({
        subscriptionId: "sub-1",
        mode: "snapshot",
        logEpoch: "epoch-1",
      });
      expect(result.ack.openTiming).toMatchObject({
        version: 1,
        hostPrepareMs: expect.any(Number),
        cliProcessState: "spawned",
      });
      expect(result).toEqual({ ack: result.ack });

      await vi.waitFor(() => {
        expect(frames).toHaveLength(1);
      });
      expect(frames[0]).toMatchObject({
        topic: "conversation/s1",
        subscriptionId: "sub-1",
        kind: "complete",
        frame: { payload: { kind: "deltas", deltas: [] } },
      });

      const subscribeRequest = readRequests(logPath).find(
        (entry) => entry.method === "v4/conversation/subscribe",
      );
      expect(subscribeRequest?.params.topic).toBe("conversation/s1");
      expect(subscribeRequest?.params.clientMode).toBe("desktop-continuous");
      expect(subscribeRequest?.params).not.toHaveProperty("deliveryProfile");
      // 这条 clientHello 没有 capabilities：订阅就不能带增量位，CLI 按旧消费者发整键 patch。
      expect(subscribeRequest?.params).not.toHaveProperty("workflowRunDeltas");
      expect(typeof subscribeRequest?.params.connectionId).toBe("string");
      expect(String(subscribeRequest?.params.connectionId)).toMatch(/^host-/);

      disposable.dispose();
    } finally {
      await service.disposeAllAndWait();
    }
  });

  it("labels mobile input from the trusted attachment instead of caller metadata", async () => {
    const { service, workspacePath, logPath } = setupService();
    const scope = createZCodeAgentConnectionScope(service, {
      connectionId: "group-mobile-origin",
      clientMode: "web-remote-replayable",
    });
    try {
      await scope.service.helloConversationV4();
      await scope.service.initializeConversationV4({
        kind: "clientHello",
        protocolVersion: 3,
        clientId: "origin-client",
        appVersion: "4.0.0",
      });
      await scope.service.sendConversationCommandV4({
        workspacePath,
        clientMode: "desktop-continuous",
        envelope: {
          commandId: "origin-command",
          clientId: "origin-client",
          sessionId: "origin-session",
          type: "sendText",
          issuedAt: 1,
          payload: { text: "hello", inputOrigin: "desktop" },
        },
      });
      expect(
        readRequests(logPath).find((entry) => entry.method === "v4/command")?.params,
      ).toMatchObject({ payload: { text: "hello", inputOrigin: "mobile" } });
    } finally {
      await scope.dispose();
      await service.disposeAllAndWait();
    }
  });

  it("does not carry runtime preferences on v4 create, send, or subscribe", async () => {
    const { service, workspacePath, logPath } = setupService();
    try {
      await service.sendConversationCommandV4({
        workspacePath,
        envelope: {
          commandId: "cmd-runtime-preferences-create",
          clientId: "client-runtime-preferences",
          sessionId: null,
          type: "createSession",
          payload: { workspaceId: workspacePath },
          issuedAt: 1_700_000_000_000,
        },
      });
      await service.sendConversationCommandV4({
        workspacePath,
        envelope: {
          commandId: "cmd-runtime-preferences-send",
          clientId: "client-runtime-preferences",
          sessionId: "s-runtime-preferences",
          type: "sendText",
          payload: { text: "continue" },
          issuedAt: 1_700_000_000_001,
        },
      });
      await service.subscribeConversationV4({
        workspacePath,
        sessionId: "s-runtime-preferences",
      });

      const requests = readRequests(logPath);
      const commands = requests.filter((entry) => entry.method === "v4/command");
      expect(commands[0]?.params).toMatchObject({
        type: "createSession",
        payload: { workspaceId: workspacePath },
      });
      expect(commands[1]?.params).toMatchObject({
        type: "sendText",
        payload: { text: "continue" },
      });
      for (const command of commands) {
        expect(command.params.payload).not.toHaveProperty("nativeSearchEnhancementsEnabled");
        expect(command.params.payload).not.toHaveProperty("memoryEnabled");
        expect(command.params.payload).not.toHaveProperty("integratedTerminalShell");
      }
      const subscribe = requests.find((entry) => entry.method === "v4/conversation/subscribe");
      expect(subscribe?.params).not.toHaveProperty("nativeSearchEnhancementsEnabled");
      expect(subscribe?.params).not.toHaveProperty("memoryEnabled");
      expect(subscribe?.params).not.toHaveProperty("integratedTerminalShell");
    } finally {
      await service.disposeAllAndWait();
    }
  });

  it("SSH sessions-index 只传递当前 identity 的 GLM task-index 归属证明", async () => {
    const { service, workspacePath, logPath } = setupService();
    const repo = new TaskIndexRepo();
    const workspaceIdentity = `remote:ssh:example.test:22:coder:${workspacePath}`;
    const foreignWorkspaceIdentity = `remote:ssh:other.example.test:22:coder:${workspacePath}`;
    try {
      await repo.syncTaskMeta({
        meta: {
          taskId: "legacy-current-ssh",
          traceId: "trace-legacy-current-ssh",
          title: "current SSH legacy task",
          workspacePath,
          workspaceIdentity,
          createdAt: 1,
          updatedAt: 2,
          mode: "build",
          provider: "glm",
        },
      });
      await repo.syncTaskMeta({
        meta: {
          taskId: "legacy-foreign-ssh",
          traceId: "trace-legacy-foreign-ssh",
          title: "foreign SSH legacy task",
          workspacePath,
          workspaceIdentity: foreignWorkspaceIdentity,
          createdAt: 1,
          updatedAt: 3,
          mode: "build",
          provider: "glm",
        },
      });

      await service.subscribeSessionsIndexV4({ workspacePath, workspaceIdentity });

      const subscribeRequest = readRequests(logPath).find(
        (entry) => entry.method === "v4/conversation/subscribe",
      );
      expect(subscribeRequest?.params).toMatchObject({
        topic: `sessions-index/${workspaceIdentity}`,
        legacyTaskIds: ["legacy-current-ssh"],
      });
    } finally {
      repo.close();
      await service.disposeAllAndWait();
    }
  });

  it("历史任务 allowlist 只开放 SSH 与 WSL identity", () => {
    expect(supportsLegacyRemoteTaskAllowlist("remote:ssh:host:22:user:/repo")).toBe(true);
    expect(supportsLegacyRemoteTaskAllowlist("remote:wsl:Ubuntu-24.04:user:/repo")).toBe(true);
    expect(supportsLegacyRemoteTaskAllowlist("remote:docker:container:/repo")).toBe(false);
    expect(supportsLegacyRemoteTaskAllowlist("/repo")).toBe(false);
  });

  it("forwards connection flow only through the non-RPC trusted scope control", async () => {
    const { service, workspacePath, logPath } = setupService();
    const scope = createZCodeAgentConnectionScope(service, {
      connectionId: "mobile-flow",
      clientMode: "web-remote-replayable",
    });
    try {
      await scope.service.helloConversationV4();
      await scope.service.initializeConversationV4({
        kind: "clientHello",
        protocolVersion: 3,
        clientId: "mobile-flow-client",
        appVersion: "4.0.0",
      });
      await scope.service.subscribeConversationV4({ workspacePath, sessionId: "s-flow" });

      await scope.setTransportFlowState("saturated");
      const flowRequest = readRequests(logPath).find(
        (entry) => entry.method === "v4/connection/flow",
      );
      expect(flowRequest?.params).toEqual({
        connectionId: "mobile-flow",
        state: "saturated",
      });

      await expect(
        scope.service.setConnectionFlowStateV4({ workspacePath, state: "drained" }),
      ).rejects.toThrow("fault.connection.flowControlForbidden");
    } finally {
      await scope.dispose();
      await service.disposeAllAndWait();
    }
  });

  it("forwards chunked attachment methods with trusted connection and <=1MiB NDJSON", async () => {
    const { service, workspacePath, logPath } = setupService();
    await expect(
      service.attachmentBeginV4({
        workspacePath,
        sessionId: "s-upload",
        uploadId: "untrusted",
        fileName: "nope.bin",
        mime: "application/octet-stream",
        totalBytes: 0,
        totalChunks: 0,
        checksum: `sha256:${"0".repeat(64)}`,
      }),
    ).rejects.toThrow("fault.attachment.connectionUntrusted");
    const scope = createZCodeAgentConnectionScope(service, {
      connectionId: "mobile-upload",
      clientMode: "web-remote-replayable",
    });
    try {
      await scope.service.helloConversationV4();
      await scope.service.initializeConversationV4({
        kind: "clientHello",
        protocolVersion: 3,
        clientId: "mobile-upload-client",
        appVersion: "4.0.0",
      });
      const common = { workspacePath, sessionId: "s-upload", uploadId: "upload-1" };
      await scope.service.attachmentBeginV4({
        ...common,
        fileName: "big.bin",
        mime: "application/octet-stream",
        totalBytes: 512 * 1024,
        totalChunks: 1,
        checksum: `sha256:${"0".repeat(64)}`,
      });
      await scope.service.attachmentChunkV4({
        ...common,
        chunkIndex: 0,
        dataBase64: Buffer.alloc(512 * 1024).toString("base64"),
      });
      await expect(scope.service.attachmentCommitV4(common)).resolves.toEqual({
        ref: "zcode-artifact://upload/one",
      });
      await scope.service.attachmentAbortV4(common);

      const attachmentLines = readFileSync(logPath, "utf8")
        .split("\n")
        .filter((line) => line.includes('"method":"v4/attachment/'));
      expect(attachmentLines).toHaveLength(4);
      for (const line of attachmentLines) {
        expect(Buffer.byteLength(`${line}\n`, "utf8")).toBeLessThanOrEqual(1024 * 1024);
        expect(JSON.parse(line).params.connectionId).toBe("mobile-upload");
      }
    } finally {
      await scope.dispose();
      await service.disposeAllAndWait();
    }
  });

  it("only queries a local video source for Desktop local connections", async () => {
    const authorizeLocalMediaPreviewPath = vi.fn(async () => "/real/video-cache/demo.mp4");
    const { service, workspacePath, logPath } = setupService({
      authorizeLocalMediaPreviewPath,
    });
    const desktop = createZCodeAgentConnectionScope(service, {
      connectionId: "desktop-preview",
      clientMode: "desktop-continuous",
    });
    const mobile = createZCodeAgentConnectionScope(service, {
      connectionId: "mobile-preview",
      clientMode: "web-remote-replayable",
    });
    try {
      for (const [scope, clientId] of [
        [desktop, "desktop-preview-client"],
        [mobile, "mobile-preview-client"],
      ] as const) {
        await scope.service.helloConversationV4();
        await scope.service.initializeConversationV4({
          kind: "clientHello",
          protocolVersion: 3,
          clientId,
          appVersion: "4.0.0",
        });
      }
      const input = {
        workspacePath,
        sessionId: "s-preview",
        ref: "/tmp/demo.mp4",
        target: { rowId: 2, entityId: "message-preview" },
        attachmentIndex: 0,
      };
      await expect(desktop.service.attachmentPreviewSourceV4(input)).resolves.toEqual({
        kind: "local_path",
        path: "/real/video-cache/demo.mp4",
        mediaType: "video/mp4",
      });
      expect(authorizeLocalMediaPreviewPath).toHaveBeenCalledOnce();
      expect(authorizeLocalMediaPreviewPath).toHaveBeenCalledWith(
        "/tmp/.zcode/video-cache/demo.mp4",
      );
      await expect(mobile.service.attachmentPreviewSourceV4(input)).resolves.toEqual({
        kind: "chunked",
      });
      await expect(
        desktop.service.attachmentPreviewSourceV4({
          ...input,
          remoteSessionId: "remote-session",
        }),
      ).resolves.toEqual({ kind: "chunked" });
      const sourceLines = readFileSync(logPath, "utf8")
        .split("\n")
        .filter((line) => line.includes('"method":"v4/attachment/previewSource"'));
      expect(sourceLines).toHaveLength(1);
      expect(JSON.parse(sourceLines[0]!).params).toMatchObject({
        clientMode: "desktop-continuous",
        sessionId: "s-preview",
        attachmentIndex: 0,
      });
    } finally {
      await desktop.dispose();
      await mobile.dispose();
      await service.disposeAllAndWait();
    }
  });

  it("fails closed when Main cannot authorize a Desktop local preview path", async () => {
    const { service, workspacePath } = setupService({
      authorizeLocalMediaPreviewPath: async () => {
        throw new Error("preview path authorization failed");
      },
    });
    const desktop = createZCodeAgentConnectionScope(service, {
      connectionId: "desktop-preview-failed",
      clientMode: "desktop-continuous",
    });
    try {
      await desktop.service.helloConversationV4();
      await desktop.service.initializeConversationV4({
        kind: "clientHello",
        protocolVersion: 3,
        clientId: "desktop-preview-failed-client",
        appVersion: "4.0.0",
      });
      await expect(
        desktop.service.attachmentPreviewSourceV4({
          workspacePath,
          sessionId: "s-preview",
          ref: "/tmp/demo.mp4",
          target: { rowId: 2, entityId: "message-preview" },
          attachmentIndex: 0,
        }),
      ).rejects.toThrow("preview path authorization failed");
    } finally {
      await desktop.dispose();
      await service.disposeAllAndWait();
    }
  });

  it.each([
    ["missing-delivery-kind", "proto.frameAssemblyMetadataMismatch"],
    ["invalid-delivery-kind", "proto.frameAssemblyMetadataMismatch"],
    ["invalid-base64", "proto.frameAssemblyInvalidBase64"],
    ["fragment-count-1025", "proto.frameFragmentCountExceeded"],
    ["missing-checksum", "proto.frameAssemblyMetadataMismatch"],
    ["checksum-value-number", "proto.frameAssemblyMetadataMismatch"],
    ["data-base64-number", "proto.frameAssemblyMetadataMismatch"],
    ["extra-inner-field", "proto.frameAssemblyMetadataMismatch"],
    ["invalid-complete", "proto.frameAssemblyInvalidPayload"],
    ["invalid-checksum-algorithm", "proto.frameAssemblyMetadataMismatch"],
    ["invalid-checksum-value", "proto.frameAssemblyMetadataMismatch"],
  ] as const)(
    "routes %s through service → owned facade → assembler typed fault",
    async (sessionId, reasonCode) => {
      const { service, workspacePath } = setupService();
      const scope = createZCodeAgentConnectionScope(service, {
        connectionId: `test-${sessionId}`,
        clientMode: "desktop-continuous",
      });
      try {
        await scope.service.helloConversationV4();
        await scope.service.initializeConversationV4({
          kind: "clientHello",
          protocolVersion: 3,
          clientId: "owned-consumer",
          appVersion: "4.0.0",
        });
        const candidates: ConversationTopicWireCandidate[] = [];
        const disposable = scope.service.onDynamicConversationFrame({ workspacePath })((wire) =>
          candidates.push(wire),
        );
        await scope.service.subscribeConversationV4({ workspacePath, sessionId });
        await vi.waitFor(() => expect(candidates).toHaveLength(1));

        const assembler = new TopicWireFrameAssembler(conversationTopicFrameSchema);
        expect(assembler.accept(candidates[0]!)).toMatchObject([
          { kind: "fault", fault: { reasonCode } },
        ]);
        disposable.dispose();
      } finally {
        await scope.dispose();
        await service.disposeAllAndWait();
      }
    },
  );

  it("records subscribe route and forwards exact topic/subscription/connection on unsubscribe", async () => {
    const { service, workspacePath, logPath } = setupService();
    try {
      const ack = await service.sendConversationCommandV4({
        workspacePath,
        envelope: {
          commandId: "cmd-1",
          clientId: "client-1",
          sessionId: "s1",
          type: "sendText",
          payload: { text: "hello" },
          issuedAt: 1700000000000,
        },
      });
      expect(ack).toEqual({
        commandId: "cmd-1",
        status: "accepted",
        revisionAtDecision: 3,
        result: {
          type: "inputAccepted",
          delivery: "startNow",
          inputId: "cmd-1",
          messageId: "msg-cmd-1",
        },
      });

      await service.subscribeConversationV4({
        workspacePath,
        sessionId: "s1",
      });
      await service.unsubscribeConversationV4({ workspacePath, subscriptionId: "sub-1" });

      const requests = readRequests(logPath);
      const commandRequest = requests.find((entry) => entry.method === "v4/command");
      expect(commandRequest?.params).toMatchObject({
        commandId: "cmd-1",
        type: "sendText",
        payload: { text: "hello" },
      });
      const unsubscribeRequest = requests.find(
        (entry) => entry.method === "v4/conversation/unsubscribe",
      );
      const subscribeRequest = requests.find(
        (entry) => entry.method === "v4/conversation/subscribe",
      );
      expect(unsubscribeRequest?.params).toEqual({
        topic: "conversation/s1",
        subscriptionId: "sub-1",
        connectionId: subscribeRequest?.params.connectionId,
      });
    } finally {
      await service.disposeAllAndWait();
    }
  });

  it("keeps automation mutation tools for desktop user turns in cron-owned sessions", async () => {
    const { service, workspacePath, logPath } = setupService();
    const repo = new TaskIndexRepo();
    try {
      await repo.syncTaskMeta({
        meta: {
          taskId: "cron-session",
          traceId: "trace-cron-session",
          title: "cron session",
          workspacePath,
          createdAt: 1,
          updatedAt: 2,
          mode: "build",
          provider: "glm",
          cronAutomationId: "automation-cron",
        },
      });

      await service.sendConversationCommandV4({
        workspacePath,
        envelope: {
          commandId: "cmd-followup",
          clientId: "desktop-client",
          sessionId: "cron-session",
          type: "sendText",
          payload: { text: "再帮我建一个每5分钟提醒" },
          issuedAt: 1700000000000,
        },
      });

      const commandRequest = readRequests(logPath).find((entry) => entry.method === "v4/command");
      expect(commandRequest?.params).toMatchObject({
        commandId: "cmd-followup",
        type: "sendText",
        payload: {
          text: "再帮我建一个每5分钟提醒",
        },
      });
      expect(commandRequest?.params.payload).not.toHaveProperty("automationId");
      expect(commandRequest?.params.payload).not.toHaveProperty("toolDisallowlist");
    } finally {
      repo.close();
      await service.disposeAllAndWait();
    }
  });

  it("hides automation mutation tools only for the current automation execution turn", async () => {
    const { service, workspacePath, logPath } = setupService();
    try {
      await service.sendConversationCommandV4({
        workspacePath,
        envelope: {
          commandId: "cmd-automation-run",
          clientId: "desktop-client",
          sessionId: "cron-session",
          type: "sendText",
          payload: {
            text: "执行定时任务",
            automationId: "automation-cron",
            toolDisallowlist: ["ExistingDeniedTool"],
          },
          issuedAt: 1700000000000,
        },
      });

      const commandRequest = readRequests(logPath).find((entry) => entry.method === "v4/command");
      expect(commandRequest?.params.payload).toEqual({
        inputOrigin: "desktop",
        text: "执行定时任务",
        automationId: "automation-cron",
        toolDisallowlist: ["ExistingDeniedTool", "CronCreate", "CronUpdate", "CronDelete"],
      });
    } finally {
      await service.disposeAllAndWait();
    }
  });

  it("does not consult cron ownership metadata for a normal desktop user turn", async () => {
    const { service, workspacePath, logPath } = setupService();
    const getTaskMeta = vi
      .spyOn(TaskIndexRepo.prototype, "getTaskMeta")
      .mockRejectedValueOnce(new Error("task index unavailable"));
    try {
      await service.sendConversationCommandV4({
        workspacePath,
        envelope: {
          commandId: "cmd-ownership-unknown",
          clientId: "desktop-client",
          sessionId: "unknown-session",
          type: "sendText",
          payload: { text: "继续正常对话" },
          issuedAt: 1700000000000,
        },
      });

      const commandRequest = readRequests(logPath).find((entry) => entry.method === "v4/command");
      expect(commandRequest?.params).toMatchObject({
        commandId: "cmd-ownership-unknown",
        type: "sendText",
        payload: {
          text: "继续正常对话",
        },
      });
      expect(commandRequest?.params.payload).not.toHaveProperty("toolDisallowlist");
      expect(getTaskMeta).not.toHaveBeenCalled();
    } finally {
      getTaskMeta.mockRestore();
      await service.disposeAllAndWait();
    }
  });

  it("PV4-24 web-remote replayable 在 shared host 原样透传组合 rewind 命令", async () => {
    const { service, workspacePath, logPath, commandResolver } = setupService();
    const workspaceIdentity = "ssh://rewind-e2e/workspace";
    const scope = createZCodeAgentConnectionScope(service, {
      connectionId: "mobile-rewind",
      clientMode: "web-remote-replayable",
    });
    try {
      await scope.service.helloConversationV4();
      await scope.service.initializeConversationV4({
        kind: "clientHello",
        protocolVersion: 3,
        clientId: "mobile-rewind-client",
        appVersion: "4.0.0",
      });
      await scope.service.subscribeConversationV4({
        workspacePath,
        workspaceIdentity,
        sessionId: "s-mobile-rewind",
      });
      const ack = await scope.service.sendConversationCommandV4({
        workspacePath,
        workspaceIdentity,
        envelope: {
          commandId: "cmd-mobile-rewind",
          clientId: "mobile-rewind-client",
          sessionId: "s-mobile-rewind",
          type: "editUserQuery",
          baseRevision: 12,
          baseLogEpoch: "epoch-mobile",
          payload: {
            target: { rowId: 18, entityId: "msg-mobile-user" },
            newText: "mobile edited query",
            workspaceMode: "rewind",
          },
          issuedAt: 1700000000000,
        },
      });

      expect(ack).toMatchObject({
        commandId: "cmd-mobile-rewind",
        status: "accepted",
      });
      const requests = readRequests(logPath);
      expect(
        requests.find((entry) => entry.method === "v4/conversation/subscribe")?.params,
      ).toMatchObject({
        clientMode: "web-remote-replayable",
        connectionId: "mobile-rewind",
        topic: "conversation/s-mobile-rewind",
      });
      expect(requests.find((entry) => entry.method === "v4/command")?.params).toEqual({
        commandId: "cmd-mobile-rewind",
        clientId: "mobile-rewind-client",
        sessionId: "s-mobile-rewind",
        type: "editUserQuery",
        baseRevision: 12,
        baseLogEpoch: "epoch-mobile",
        payload: {
          target: { rowId: 18, entityId: "msg-mobile-user" },
          newText: "mobile edited query",
          workspaceMode: "rewind",
        },
        issuedAt: 1700000000000,
      });
      // 同一 workspaceIdentity 的 subscribe + command 复用同一 host child，
      // 手机端不单独创建 Agent runtime，relay/main 也不持有 rewind 状态。
      expect(commandResolver).toHaveBeenCalledTimes(1);
    } finally {
      await scope.dispose();
      await service.disposeAllAndWait();
    }
  });

  it("commands/query 经真实 child process wire 保序，且 64 cap/可信 scope 在 service 边界执行", async () => {
    const { service, workspacePath, logPath } = setupService();
    const commands = Array.from({ length: 64 }, (_, index) => ({
      sessionId: index === 0 ? null : "s1",
      commandId: `command-${index}`,
    }));
    const scope = createZCodeAgentConnectionScope(service, {
      connectionId: "query-wire",
      clientMode: "web-remote-replayable",
    });
    try {
      await expect(
        service.queryConversationCommandsV4({ workspacePath, commands: [commands[0]!] }),
      ).rejects.toThrow("fault.command.queryConnectionUntrusted");

      await scope.service.helloConversationV4();
      await scope.service.initializeConversationV4({
        kind: "clientHello",
        protocolVersion: 3,
        clientId: "query-wire-client",
        appVersion: "4.0.0",
      });
      const result = await scope.service.queryConversationCommandsV4({ workspacePath, commands });
      expect(result.results.map((item) => item.key.commandId)).toEqual(
        commands.map((key) => key.commandId),
      );
      expect(result.results.every((item) => item.result === "unknown")).toBe(true);

      await expect(
        scope.service.queryConversationCommandsV4({
          workspacePath,
          commands: [...commands, { sessionId: "s1", commandId: "command-64" }],
        }),
      ).rejects.toThrow();
      const requests = readRequests(logPath).filter(
        (entry) => entry.method === "v4/commands/query",
      );
      expect(requests).toHaveLength(1);
      expect(requests[0]?.params).toEqual({ commands });
    } finally {
      await scope.dispose();
      await service.disposeAllAndWait();
    }
  });

  it("forwards same-sub resync with the recorded exact route and client base", async () => {
    const { service, workspacePath, logPath } = setupService();
    try {
      const subscribed = await service.subscribeConversationV4({
        workspacePath,
        sessionId: "s-resync",
      });
      const result = await service.resyncConversationV4({
        workspacePath,
        subscriptionId: subscribed.ack.subscriptionId,
        base: { logEpoch: "epoch-1", seq: 0 },
        forceSnapshot: true,
      });
      expect(result.ack).toEqual({
        subscriptionId: subscribed.ack.subscriptionId,
        mode: "snapshot",
        logEpoch: "epoch-1",
      });
      const requests = readRequests(logPath);
      const subscribeRequest = requests.find(
        (entry) =>
          entry.method === "v4/conversation/subscribe" &&
          entry.params.topic === "conversation/s-resync",
      );
      const resyncRequest = requests.find((entry) => entry.method === "v4/conversation/resync");
      expect(resyncRequest?.params).toEqual({
        topic: "conversation/s-resync",
        connectionId: subscribeRequest?.params.connectionId,
        subscriptionId: subscribed.ack.subscriptionId,
        base: { logEpoch: "epoch-1", seq: 0 },
        forceSnapshot: true,
      });
    } finally {
      await service.disposeAllAndWait();
    }
  });

  it("迟到 unsubscribe response 不删除同 key 的新 route", async () => {
    const { service, workspacePath, logPath } = setupService();
    try {
      const first = await service.subscribeConversationV4({
        workspacePath,
        sessionId: "delayed-unsubscribe",
      });
      const staleUnsubscribe = service.unsubscribeConversationV4({
        workspacePath,
        subscriptionId: first.ack.subscriptionId,
      });
      await vi.waitFor(() => {
        expect(
          readRequests(logPath).some((entry) => entry.method === "v4/conversation/unsubscribe"),
        ).toBe(true);
      });

      const replacement = await service.subscribeConversationV4({
        workspacePath,
        sessionId: "delayed-unsubscribe",
      });
      expect(replacement.ack.subscriptionId).toBe(first.ack.subscriptionId);
      await staleUnsubscribe;

      await expect(
        service.resyncConversationV4({
          workspacePath,
          subscriptionId: replacement.ack.subscriptionId,
          base: { logEpoch: replacement.ack.logEpoch, seq: 0 },
        }),
      ).resolves.toMatchObject({ ack: { subscriptionId: replacement.ack.subscriptionId } });
    } finally {
      await service.disposeAllAndWait();
    }
  });

  it("route 换代后迟到 resync response 必须拒绝 stale success", async () => {
    const { service, workspacePath, logPath } = setupService();
    try {
      const first = await service.subscribeConversationV4({
        workspacePath,
        sessionId: "delayed-resync",
      });
      const staleResync = service.resyncConversationV4({
        workspacePath,
        subscriptionId: first.ack.subscriptionId,
        base: { logEpoch: first.ack.logEpoch, seq: 0 },
      });
      await vi.waitFor(() => {
        expect(
          readRequests(logPath).some((entry) => entry.method === "v4/conversation/resync"),
        ).toBe(true);
      });

      const replacement = await service.subscribeConversationV4({
        workspacePath,
        sessionId: "delayed-resync",
      });
      expect(replacement.ack.subscriptionId).toBe(first.ack.subscriptionId);
      await expect(staleResync).rejects.toThrow("fault.subscription.notOwned");
    } finally {
      await service.disposeAllAndWait();
    }
  });

  it("disposeWorkspace runtime invalidation 后三类 pre-restart listener 均接收新 runtime initial", async () => {
    const { service, workspacePath } = setupService();
    try {
      const frames: ConversationTopicWireCandidate[] = [];
      const indexFrames: SessionsIndexTopicWireCandidate[] = [];
      const configFrames: WorkspaceConfigTopicWireCandidate[] = [];
      const disposables = [
        service.onDynamicConversationFrame({ workspacePath })((frame) => frames.push(frame)),
        service.onDynamicSessionsIndexFrame({ workspacePath })((frame) => indexFrames.push(frame)),
        service.onDynamicWorkspaceConfigFrame({ workspacePath })((frame) =>
          configFrames.push(frame),
        ),
      ];
      await Promise.all([
        service.subscribeConversationV4({ workspacePath, sessionId: "before-restart" }),
        service.subscribeSessionsIndexV4({ workspacePath }),
        service.subscribeWorkspaceConfigV4({ workspacePath }),
      ]);
      await vi.waitFor(() => {
        expect(frames).toHaveLength(1);
        expect(indexFrames).toHaveLength(1);
        expect(configFrames).toHaveLength(1);
      });

      await service.disposeWorkspace({ workspacePath });
      await Promise.all([
        service.subscribeConversationV4({ workspacePath, sessionId: "after-restart" }),
        service.subscribeSessionsIndexV4({ workspacePath }),
        service.subscribeWorkspaceConfigV4({ workspacePath }),
      ]);
      await vi.waitFor(() => {
        expect(frames).toHaveLength(2);
        expect(indexFrames).toHaveLength(2);
        expect(configFrames).toHaveLength(2);
      });
      expect(frames.map((frame) => frame.topic)).toEqual([
        "conversation/before-restart",
        "conversation/after-restart",
      ]);
      expect(indexFrames.every((frame) => frame.topic.startsWith("sessions-index/"))).toBe(true);
      expect(configFrames.every((frame) => frame.topic.startsWith("workspace-config/"))).toBe(true);
      for (const disposable of disposables) disposable.dispose();
    } finally {
      await service.disposeAllAndWait();
    }
  });

  it("conversation/sessions-index/workspace-config 相同裸 subId 各自使用记录的精确 route", async () => {
    const { service, workspacePath, logPath } = setupService();
    try {
      const conversation = await service.subscribeConversationV4({
        workspacePath,
        sessionId: "s1",
      });
      const sessionsIndex = await service.subscribeSessionsIndexV4({
        workspacePath,
      });
      const workspaceConfig = await service.subscribeWorkspaceConfigV4({
        workspacePath,
      });
      expect([
        conversation.ack.subscriptionId,
        sessionsIndex.ack.subscriptionId,
        workspaceConfig.ack.subscriptionId,
      ]).toEqual(["sub-1", "sub-1", "sub-1"]);

      await service.unsubscribeConversationV4({
        workspacePath,
        subscriptionId: "sub-1",
      });
      await service.unsubscribeSessionsIndexV4({
        workspacePath,
        subscriptionId: "sub-1",
      });
      await service.unsubscribeWorkspaceConfigV4({
        workspacePath,
        subscriptionId: "sub-1",
      });

      const requests = readRequests(logPath);
      const subscribeRequests = requests.filter(
        (entry) => entry.method === "v4/conversation/subscribe",
      );
      const unsubscribeRequests = requests.filter(
        (entry) => entry.method === "v4/conversation/unsubscribe",
      );
      expect(unsubscribeRequests.map((entry) => entry.params)).toEqual(
        subscribeRequests.map((entry) => ({
          topic: entry.params.topic,
          subscriptionId: "sub-1",
          connectionId: entry.params.connectionId,
        })),
      );
    } finally {
      await service.disposeAllAndWait();
    }
  });

  it("trusted unsubscribe route 不能跨越调用方法的 topic 域", async () => {
    const { service, workspacePath, logPath } = setupService();
    try {
      const config = await service.subscribeWorkspaceConfigV4({
        workspacePath,
      });
      const configSubscribe = readRequests(logPath).find(
        (entry) =>
          entry.method === "v4/conversation/subscribe" &&
          String(entry.params.topic).startsWith("workspace-config/"),
      );
      expect(configSubscribe).toBeDefined();

      await service.unsubscribeConversationV4({
        workspacePath,
        subscriptionId: config.ack.subscriptionId,
        __zcodeTrustedV4UnsubscribeRoute: {
          topic: configSubscribe?.params.topic,
          connectionId: configSubscribe?.params.connectionId,
        },
      } as never);

      expect(
        readRequests(logPath).filter((entry) => entry.method === "v4/conversation/unsubscribe"),
      ).toHaveLength(0);
    } finally {
      await service.disposeAllAndWait();
    }
  });
});
