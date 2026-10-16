/**
 * 种子截断复制的幂等与「绝不写进已开跑会话」两条规则
 * （apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Driver side: boundaries and seeding」）。
 *
 * 走真 SQLite 会话存储：这两条规则的判据是消息 id 与消息条数，而 `messages()` 的返回顺序
 * （按 `sequence` 升序）正是判据的一半——用假 store 就把被测的那个性质自己假设掉了。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import {
  createMessageId,
  createPartId,
  type MessageId,
  type MessagePart,
  type SessionId,
} from "@zcode/contracts";
import { WorkflowError } from "@zcode/dynamic-workflow";
import {
  seedActorTranscript,
  type ActorTranscriptStore,
} from "../src/app/workflow-actor-transcript.js";

const SOURCE = "sess-source" as SessionId;
const TARGET = "sess-target" as SessionId;
const CWD = "/tmp/dwf-seed";

type Store = ActorTranscriptStore & {
  close(): void;
  createSession(input: unknown): Promise<unknown>;
};

/**
 * 种子副本的 id 规则，与 workflow-actor-transcript.ts 的 `seededMessageId` 必须逐字一致——
 * 这正是「这条消息是不是我抄进来的」的判据，所以连 `createMessageId` 的前缀都得走同一个函数。
 */
function seedId(sessionId: SessionId, index: number): MessageId {
  return createMessageId(`${sessionId}-seed-${index}`);
}

async function saveMessage(
  store: ActorTranscriptStore,
  input: {
    id: MessageId;
    sessionId: SessionId;
    text: string;
    at: number;
    /** 缺省是一个与消息 id 绑定的 part id；种子前缀要用生产那一套（见 {@link fillSeeded}）。 */
    partId?: MessagePart["id"];
  },
): Promise<void> {
  await store.saveMessage({
    id: input.id,
    sessionID: input.sessionId,
    role: "user",
    time: { created: input.at },
    path: { cwd: CWD, root: CWD },
  } as never);
  await store.savePart({
    id: input.partId ?? (`${input.id}_text` as MessagePart["id"]),
    sessionID: input.sessionId,
    messageID: input.id,
    type: "text",
    text: input.text,
    time: { start: input.at, end: input.at },
  } as never);
}

/** 源会话：`count` 条可辨认的消息。 */
async function fillSource(store: ActorTranscriptStore, count: number): Promise<void> {
  for (let index = 0; index < count; index++) {
    await saveMessage(store, {
      id: `src-${index}` as MessageId,
      sessionId: SOURCE,
      text: `source ${index}`,
      at: index + 1,
    });
  }
}

/**
 * 目标会话：`count` 条**种子 id** 的消息（一截复制出来的前缀）。
 *
 * 消息与 part 的 id 都按生产那一套铸（`seededMessageId` / `seededPartId`），因为重抄靠的正是
 * 「同 id upsert」：part id 若不同，重抄就会在同一条消息下多长出一个 part 而不是覆盖它。
 */
async function fillSeeded(store: ActorTranscriptStore, count: number): Promise<void> {
  for (let index = 0; index < count; index++) {
    await saveMessage(store, {
      id: seedId(TARGET, index),
      sessionId: TARGET,
      text: `seeded ${index}`,
      at: index + 1,
      partId: createPartId(`${TARGET}-seed-${index}-0`),
    });
  }
}

async function textsOf(store: ActorTranscriptStore, sessionId: SessionId): Promise<string[]> {
  const messages = await store.messages({ sessionID: sessionId });
  return messages.map((message) =>
    message.parts.map((part) => (part.type === "text" ? part.text : "")).join(""),
  );
}

/** `message.session_id` 对 `session(id)` 有 FK，所以两个会话行都得先落。 */
async function createSessionRow(store: Store, sessionId: SessionId): Promise<void> {
  await store.createSession({
    id: sessionId,
    projectID: "project_dwf_seed",
    slug: `slug-${sessionId}`,
    directory: CWD,
    path: CWD,
    title: `session ${sessionId}`,
    version: "test-version",
    time: { created: 1, updated: 1 },
  } as never);
}

async function withStore(body: (store: Store) => Promise<void>): Promise<void> {
  const tempRoot = await mkdtemp(join(tmpdir(), "zcode-dwf-seed-"));
  const store = createSqliteSessionStore({
    dbPath: join(tempRoot, "session.sqlite"),
  }) as unknown as Store;
  try {
    await createSessionRow(store, SOURCE);
    await createSessionRow(store, TARGET);
    await body(store);
  } finally {
    store.close();
    await rm(tempRoot, { force: true, recursive: true });
  }
}

describe("seedActorTranscript — 跳过规则", () => {
  it("目标已有 ≥ messageCount 条 → 整段跳过（崩溃后 resume 的常态）", async () => {
    await withStore(async (store) => {
      await fillSource(store, 4);
      await fillSeeded(store, 3);

      const copied = await seedActorTranscript({
        seed: { sourceSessionId: SOURCE, messageCount: 3 },
        store,
        targetSessionId: TARGET,
      });
      expect(copied).toBeUndefined();
      expect(await textsOf(store, TARGET)).toEqual(["seeded 0", "seeded 1", "seeded 2"]);
    });
  });

  // 复制中途崩溃留下的半截前缀：全是种子 id，所以补齐它是安全的。
  it("目标只有 k < N 条种子消息 → 补齐到 N", async () => {
    await withStore(async (store) => {
      await fillSource(store, 4);
      await fillSeeded(store, 1);

      const copied = await seedActorTranscript({
        seed: { sourceSessionId: SOURCE, messageCount: 3 },
        store,
        targetSessionId: TARGET,
      });
      expect(copied).toBe(3);
      // 前一条被同 id upsert 成源的内容，后两条是新抄的；顺序与源一致。
      expect(await textsOf(store, TARGET)).toEqual(["source 0", "source 1", "source 2"]);
    });
  });

  // 同一条 ask 的更晚快照：目标仍只有种子消息，所以延长到 M 是安全的。
  it("目标是 N 条种子消息、边界长到 M > N → 延长到 M", async () => {
    await withStore(async (store) => {
      await fillSource(store, 5);
      await fillSeeded(store, 2);

      const copied = await seedActorTranscript({
        seed: { sourceSessionId: SOURCE, messageCount: 4 },
        store,
        targetSessionId: TARGET,
      });
      expect(copied).toBe(4);
      expect(await textsOf(store, TARGET)).toEqual([
        "source 0",
        "source 1",
        "source 2",
        "source 3",
      ]);
    });
  });

  /**
   * 本轮的核心防线：目标已经有自己的 live 消息，而重建出来的边界比目标总条数还大。
   *
   * 老规则会重抄 0..M-1——前面那些是对种子 id 的 upsert，而 N..M-1 是新 id，于是前驱的消息被
   * 追加到本会话自己的历史**之后**（`sequence` 在 insert 时取 max+1）。那是一段前后颠倒、且
   * 不属于这个子代理的上文，而且悄无声息。
   */
  it("目标已有自己的 live 消息 → 一个字节都不写，哪怕总条数不足 messageCount", async () => {
    await withStore(async (store) => {
      await fillSource(store, 9);
      await fillSeeded(store, 2);
      // 本会话自己跑出来的两条：id 不是种子 id。
      await saveMessage(store, {
        id: "live-0" as MessageId,
        sessionId: TARGET,
        text: "live 0",
        at: 10,
      });
      await saveMessage(store, {
        id: "live-1" as MessageId,
        sessionId: TARGET,
        text: "live 1",
        at: 11,
      });
      const before = await textsOf(store, TARGET);

      const copied = await seedActorTranscript({
        seed: { sourceSessionId: SOURCE, messageCount: 7 },
        store,
        targetSessionId: TARGET,
      });
      expect(copied).toBeUndefined();
      expect(await textsOf(store, TARGET)).toEqual(before);
      // 尤其是：没有任何一条前驱消息被追加到 live 消息之后。
      expect(await textsOf(store, TARGET)).toEqual(["seeded 0", "seeded 1", "live 0", "live 1"]);
    });
  });

  it("空目标照常复制", async () => {
    await withStore(async (store) => {
      await fillSource(store, 3);

      const copied = await seedActorTranscript({
        seed: { sourceSessionId: SOURCE, messageCount: 2 },
        store,
        targetSessionId: TARGET,
      });
      expect(copied).toBe(2);
      expect(await textsOf(store, TARGET)).toEqual(["source 0", "source 1"]);
    });
  });

  // 源短于边界是 corruption 级：service 侧的门本该先把这种候选弃掉（见那边的 countSource）。
  it("源会话短于边界 → DriverError", async () => {
    await withStore(async (store) => {
      await fillSource(store, 2);

      await expect(
        seedActorTranscript({
          seed: { sourceSessionId: SOURCE, messageCount: 5 },
          store,
          targetSessionId: TARGET,
        }),
      ).rejects.toThrow(WorkflowError);
      expect(await textsOf(store, TARGET)).toEqual([]);
    });
  });

  it("跳过写进已开跑会话时记一条 warn（边界长大的唯一可见处）", async () => {
    await withStore(async (store) => {
      await fillSource(store, 9);
      await fillSeeded(store, 1);
      await saveMessage(store, {
        id: "live-0" as MessageId,
        sessionId: TARGET,
        text: "live 0",
        at: 10,
      });
      const warnings: { message: string; context?: Record<string, unknown> }[] = [];

      await seedActorTranscript({
        logger: {
          warn: (message: string, context?: Record<string, unknown>) =>
            warnings.push({ message, context }),
        } as never,
        seed: { sourceSessionId: SOURCE, messageCount: 7 },
        store,
        targetSessionId: TARGET,
      });

      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.context).toMatchObject({
        event: "dynamic_workflow.actor.seed_skipped_live_session",
        existingMessageCount: 2,
        messageCount: 7,
      });
    });
  });
});
