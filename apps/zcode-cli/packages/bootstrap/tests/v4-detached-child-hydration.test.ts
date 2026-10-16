// detached live child（dwf workflow actor / subagent child）的首次订阅 hydration。
//
// Bug 根因（本文件的存在理由）：这类子会话没有自己的 bootstrap record——事件经
// ingestDetachedLiveSession 走父 record 的 sink 路由。旧 loadPersistedEvents 用
// context.sessions.get(childSessionId) 直取，取不到就返回 synthesized:false，
// performHydration 因此走"保留健康 live publisher"早退分支，durable transcript 三源合并
// 从不执行：只有本次 live 事件进入投影，任何**不以 live 事件形态出现**的持久正文全部丢失。
// amend-resume 正是这种形态——它把前驱 actor 的 transcript 前缀直接复制进 session store
// 来播种新 actor 会话（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md），侧栏于是只剩本轮增量。
//
// 覆盖面：
//   1. child 无 record + 持久 parentID 指向 live 父 record → 播种前缀与 live 增量同时在投影里
//   2. child 既无 record 又无法经 parentID 落到任何 record → 维持修复前行为（空、非合成）
//   3. 自身有 record 的会话仍走直取 record，不被 parentID 回退改写
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInMemorySessionEventStore, createSqliteSessionStore } from "@zcode/adapters/storage";
import { conversationTopic } from "@zcode/shared/zcode-protocol-v4";
import type {
  EventId,
  MessageId,
  MessagePart,
  ModelId,
  ModelProviderId,
  ProjectId,
  SessionEvent,
  SessionEventType as SessionEventTypeUnion,
  SessionEventStorePort,
  SessionId,
  TraceId,
  TurnId,
} from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";
import { createConversationV4Gateway } from "../src/zcode-protocol/v4-bridge.js";
import type {
  ZCodeProtocolAgentServerContext,
  ZCodeProtocolSessionRecord,
} from "../src/zcode-protocol/server-types.js";

type TestSessionStore = ReturnType<typeof createSqliteSessionStore>;

const WORKSPACE_PATH = "/tmp/zcode-detached-child";
const PARENT_SESSION_ID = "sess_parent_chat" as SessionId;
const CHILD_SESSION_ID = "sess_actor_child" as SessionId;

class EventLog {
  private seq = 0;

  constructor(private readonly sessionId: string) {}

  push(type: SessionEventTypeUnion, payload: unknown, opts: { turnId?: string } = {}): SessionEvent {
    this.seq += 1;
    return {
      id: `${this.sessionId}-event-${this.seq}` as EventId,
      sessionId: this.sessionId as SessionId,
      turnId: opts.turnId as TurnId | undefined,
      type,
      timestamp: new Date(1_700_000_000_000 + this.seq * 1000),
      traceId: "trace-detached" as TraceId,
      sequenceNumber: this.seq,
      payload,
    } as SessionEvent;
  }
}

async function saveUserTextMessage(
  store: TestSessionStore,
  sessionId: SessionId,
  messageId: MessageId,
  text: string,
  created: number,
): Promise<void> {
  await store.saveMessage({
    id: messageId,
    sessionID: sessionId,
    role: "user",
    time: { created },
    agent: "zcode-agent",
    model: { providerID: "glm" as ModelProviderId, modelID: "glm-4-air" as ModelId },
    tools: {},
  });
  await store.savePart({
    id: `${messageId}_text` as MessagePart["id"],
    sessionID: sessionId,
    messageID: messageId,
    type: "text",
    text,
    time: { start: created, end: created },
  });
}

async function saveAssistantTextMessage(
  store: TestSessionStore,
  sessionId: SessionId,
  messageId: MessageId,
  parentMessageId: MessageId,
  text: string,
  created: number,
): Promise<void> {
  await store.saveMessage({
    id: messageId,
    sessionID: sessionId,
    role: "assistant",
    time: { created, completed: created },
    parentID: parentMessageId,
    providerID: "glm" as ModelProviderId,
    modelID: "glm-4-air" as ModelId,
    mode: "build",
    agent: "zcode-agent",
    path: { cwd: WORKSPACE_PATH, root: WORKSPACE_PATH },
    cost: 0,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
  });
  await store.savePart({
    id: `${messageId}_text` as MessagePart["id"],
    sessionID: sessionId,
    messageID: messageId,
    type: "text",
    text,
    time: { start: created, end: created },
  });
}

/** amend-resume 的播种形态：前驱 transcript 前缀被直接复制进新 actor 会话的 store。 */
async function seedActorTranscriptPrefix(
  store: TestSessionStore,
  sessionId: SessionId,
  label: string,
): Promise<void> {
  await saveUserTextMessage(
    store,
    sessionId,
    `${sessionId}-seed-0` as MessageId,
    `${label} 播种提问`,
    1,
  );
  await saveAssistantTextMessage(
    store,
    sessionId,
    `${sessionId}-seed-1` as MessageId,
    `${sessionId}-seed-0` as MessageId,
    `${label} 播种回答`,
    2,
  );
}

/**
 * 只包含 loadPersistedEvents 真正触碰到的字段：共享 event store、artifact reader、
 * contextWindow 解析用的 runtime 模型选择（getSessionModelSelection） 与 workspace。其余能力留空即可，
 * 缺失时 gateway 的 seed 钩子对 child 一律返回 null（child 本就没有 record）。
 */
function makeBackingRecord(eventStore: SessionEventStorePort): ZCodeProtocolSessionRecord {
  return {
    app: {
      readToolResultArtifact: async () => ({ content: "" }),
      runtime: {
        getSessionModelSelection: () => ({ providerId: "glm", modelId: "glm-4-air" }),
        // listSessionSubagents 只在会话**自身**有 record 时读它（subagent 投影的 live 补充）；
        // 这里没有 subagent，返回空投影即可。
        // readSessionContextUsage（staging 6d4c3cc571 起在 loadPersistedEvents 里同步读容量种子）要读
        // projection.contextWindow / contextUsed；给一份最小投影即可，子代理投影本就为空。
        getProjection: async () => ({ contextUsed: 0, contextWindow: 200_000 }) as never,
      },
      sessionId: PARENT_SESSION_ID,
    },
    createdAt: 0,
    eventStore,
    persistence: "immediate",
    stateRevision: 1,
    updatedAt: 0,
    workspace: {
      workspaceKey: `local:${WORKSPACE_PATH}`,
      workspacePath: WORKSPACE_PATH,
    },
  } as unknown as ZCodeProtocolSessionRecord;
}

function makeContext(input: {
  sessions: Map<string, ZCodeProtocolSessionRecord>;
  store: TestSessionStore;
}): ZCodeProtocolAgentServerContext {
  const context = {
    appRuntimePreferences: {
      askUserQuestionAutoResolutionEnabled: false,
      modelIoFullRetentionEnabled: false,
    },
    deps: { sessionStore: input.store },
    notify: () => {},
    requestClient: async () => {
      throw new Error("detached-child hydration test does not issue reverse requests");
    },
    sessions: input.sessions,
    v4Interactions: { resolve: () => false },
    workspaceModelCatalogs: new Map(),
  } as unknown as ZCodeProtocolAgentServerContext;
  return context;
}

/** child 的 live in-flight turn：TurnStarted 无终结事件 → cold merge 认定为内存权威轮次。 */
async function ingestLiveTurn(
  gateway: ReturnType<typeof createConversationV4Gateway>,
  eventStore: SessionEventStorePort,
  sessionId: string,
  liveText: string,
): Promise<void> {
  const log = new EventLog(sessionId);
  const events = [
    log.push(SessionEventType.SessionCreated, { mode: "build", contextWindow: 200_000 }),
    log.push(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: `${liveText} 提问` },
      { turnId: `${sessionId}-turn-live` },
    ),
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_delta", delta: `${liveText} 增量`, done: false },
      { turnId: `${sessionId}-turn-live` },
    ),
  ];
  for (const event of events) {
    // 生产形态：子 runtime 与父 runtime 共享 event store（按子 sessionId 归档），
    // 同一条事件另经父 record 的外部 sink 路由到 gateway 的 detached live 通道。
    await eventStore.append(event);
    gateway.ingestDetachedLiveSession(sessionId, event);
  }
}

async function snapshotRowTexts(
  gateway: ReturnType<typeof createConversationV4Gateway>,
  sessionId: string,
): Promise<string[]> {
  const result = await gateway.subscribe({
    topic: conversationTopic(sessionId),
    connectionId: `conn-${sessionId}`,
    clientMode: "desktop-continuous",
  });
  const payload = result.initialFrame?.payload;
  if (payload?.kind !== "snapshot") throw new Error("Expected snapshot initial frame");
  return payload.snapshot.rows.window.flatMap((row) =>
    "text" in row && typeof row.text === "string" && row.text.length > 0 ? [row.text] : [],
  );
}

describe("v4 detached live child 的首次订阅 hydration", () => {
  let tempRoot: string;
  let store: TestSessionStore;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "zcode-detached-child-"));
    store = createSqliteSessionStore({ dbPath: join(tempRoot, "sessions.db") });
  });

  afterEach(async () => {
    store.close();
    await rm(tempRoot, { force: true, recursive: true });
  });

  async function createSessionRow(sessionId: SessionId, parentId?: SessionId): Promise<void> {
    await store.createSession({
      id: sessionId,
      ...(parentId ? { parentID: parentId } : {}),
      projectID: "project_detached_child" as ProjectId,
      slug: `slug-${sessionId}`,
      directory: WORKSPACE_PATH,
      path: WORKSPACE_PATH,
      title: `session ${sessionId}`,
      version: "test-version",
      time: { created: 1, updated: 4 },
    });
  }

  it("child 无 record：经持久 parentID 落到父 record，播种前缀与 live 增量同时可见", async () => {
    await createSessionRow(PARENT_SESSION_ID);
    await createSessionRow(CHILD_SESSION_ID, PARENT_SESSION_ID);
    await seedActorTranscriptPrefix(store, CHILD_SESSION_ID, "actor");

    const eventStore = createInMemorySessionEventStore();
    const sessions = new Map<string, ZCodeProtocolSessionRecord>([
      [PARENT_SESSION_ID, makeBackingRecord(eventStore)],
    ]);
    const context = makeContext({ sessions, store });
    const gateway = createConversationV4Gateway(context);
    context.v4Gateway = gateway;

    await ingestLiveTurn(gateway, eventStore, CHILD_SESSION_ID, "live");
    const texts = await snapshotRowTexts(gateway, CHILD_SESSION_ID);

    // 修复前这里只有 live 两行：播种前缀从不进入投影。
    expect(texts).toContain("actor 播种提问");
    expect(texts).toContain("actor 播种回答");
    expect(texts).toContain("live 提问");
    expect(texts).toContain("live 增量");
    // 顺序也必须是"播种前缀在前、live 轮次在后"。
    expect(texts.indexOf("actor 播种回答")).toBeLessThan(texts.indexOf("live 增量"));
  });

  it("child 既无 record、parentID 也落不到任何 record：维持修复前的空非合成 hydration", async () => {
    const orphanParentId = "sess_parent_not_resident" as SessionId;
    await createSessionRow(orphanParentId);
    await createSessionRow(CHILD_SESSION_ID, orphanParentId);
    await seedActorTranscriptPrefix(store, CHILD_SESSION_ID, "orphan");

    const eventStore = createInMemorySessionEventStore();
    // 注册表里只有一个与本 child 无关的会话：parentID 查不到常驻 record。
    const sessions = new Map<string, ZCodeProtocolSessionRecord>([
      [PARENT_SESSION_ID, makeBackingRecord(eventStore)],
    ]);
    const context = makeContext({ sessions, store });
    const gateway = createConversationV4Gateway(context);
    context.v4Gateway = gateway;

    await ingestLiveTurn(gateway, eventStore, CHILD_SESSION_ID, "live");
    const texts = await snapshotRowTexts(gateway, CHILD_SESSION_ID);

    expect(texts).toEqual(["live 提问", "live 增量"]);
  });

  it("自身有 record 的会话仍直取自己的 record，不被 parentID 回退改写", async () => {
    await createSessionRow(PARENT_SESSION_ID);
    // 该会话既有自己的 record，持久层又记着 parentID；直取必须优先。
    await createSessionRow(CHILD_SESSION_ID, PARENT_SESSION_ID);
    await seedActorTranscriptPrefix(store, CHILD_SESSION_ID, "self");

    const ownEventStore = createInMemorySessionEventStore();
    const parentEventStore = createInMemorySessionEventStore();
    const sessions = new Map<string, ZCodeProtocolSessionRecord>([
      [PARENT_SESSION_ID, makeBackingRecord(parentEventStore)],
      [CHILD_SESSION_ID, makeBackingRecord(ownEventStore)],
    ]);
    const context = makeContext({ sessions, store });
    const gateway = createConversationV4Gateway(context);
    context.v4Gateway = gateway;

    // 判别器：父 record 的 store 里放一条**只有走 parentID 回退才读得到**的伪造事件。
    // 直取生效时它不该出现在投影里。
    await ingestLiveTurn(gateway, ownEventStore, CHILD_SESSION_ID, "live");
    const decoy = new EventLog(`${CHILD_SESSION_ID}-decoy`);
    await parentEventStore.append({
      ...decoy.push(
        SessionEventType.ModelStreaming,
        { kind: "text_delta", delta: "父 record 污染", done: false },
        { turnId: `${CHILD_SESSION_ID}-turn-live` },
      ),
      sessionId: CHILD_SESSION_ID,
    });

    const texts = await snapshotRowTexts(gateway, CHILD_SESSION_ID);
    expect(texts).toContain("self 播种提问");
    expect(texts).toContain("live 增量");
    expect(texts.join("")).not.toContain("父 record 污染");
  });
});
