import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { clearAppData, DEFAULT_WORKSPACE } from "../../../helpers/desktop-app.js";
import {
  clickChatStop,
  getChatRootSnapshot,
  prepareConversationE2E,
  sendPrompt,
  waitForAssistantMessageContaining,
  waitForChatState,
  waitForComposerText,
  waitForUpstreamRequest,
  waitForToolCallBlockByToolName,
  waitForUserMessageContaining,
} from "../../../helpers/conversation-session.js";
import { UPSTREAM_MODEL } from "../../../helpers/upstream-provider.js";

const CASE_NAME = "conversation-session-read-session-context-timeout";
const SOURCE_SESSION_ID = "sess_e2e_read_session_context_timeout_source";
const SOURCE_SESSION_TITLE = "E2E ReadSessionContext Timeout Source";
const SOURCE_PROJECT_ID = "proj_e2e_read_session_context_timeout";
const SOURCE_TRACE_ID = "trace_e2e_read_session_context_timeout";
const SOURCE_USER_MESSAGE_ID = "msg_e2e_rsc_timeout_source_user";
const SOURCE_ASSISTANT_MESSAGE_ID = "msg_e2e_rsc_timeout_source_assistant";
const SOURCE_USER_PART_ID = "part_e2e_rsc_timeout_source_user_text";
const SOURCE_ASSISTANT_PART_ID = "part_e2e_rsc_timeout_source_assistant_text";
const PROVIDER_ID = "e2e-upstream";
const MODEL_ID = UPSTREAM_MODEL;
const SOURCE_MARKER = "E2E_RSC_TIMEOUT_SOURCE_DECISION";
const TARGET_MARKER = "E2E_RSC_TIMEOUT_TARGET";
const LITE_QUERY_MARKER = "E2E_RSC_TIMEOUT_QUERY";
const FINAL_MARKER = "E2E_RSC_TIMEOUT_FINAL_OK";
const READ_SESSION_CONTEXT_TOOL_NAME = "ReadSessionContext";
const LITE_FIXTURE_ID = "upstream-read-session-context-timeout-lite-extraction";
const LITE_DELAY_MS = 55_000;
const STILL_RUNNING_ASSERTION_DELAY_MS = 46_000;

describe("会话区 ReadSessionContext 超时边界 E2E", () => {
  afterEach(async () => {
    await stopRunningTurnIfNeeded();
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("O07: ReadSessionContext 内部 lite 抽取超过 45 秒仍应完成当前 turn", async function () {
    this.timeout(180000);

    await prepareConversationE2E();
    await seedReadSessionContextSourceSession();

    const prompt = [
      `${TARGET_MARKER}_${Date.now()}:`,
      `Use #${SOURCE_SESSION_ID} with ${READ_SESSION_CONTEXT_TOOL_NAME}.`,
      `Ask for ${LITE_QUERY_MARKER}.`,
      `Then reply with exactly "${FINAL_MARKER}" and no other text.`,
    ].join(" ");

    await sendPrompt(prompt);
    await waitForComposerText("", "ReadSessionContext timeout prompt 发送后输入框没有清空");
    await waitForUserMessageContaining(TARGET_MARKER);
    await waitForUserMessageContaining(SOURCE_SESSION_ID);
    await waitForUserMessageContaining(LITE_QUERY_MARKER);
    await waitForToolCallBlockByToolName(READ_SESSION_CONTEXT_TOOL_NAME, 30000);
    await waitForUpstreamRequest(
      {
        excludes: ["Generate a concise title"],
        includes: [
          "You are the extraction model for the ReadSessionContext tool.",
          LITE_QUERY_MARKER,
          SOURCE_MARKER,
        ],
      },
      "没有捕获到 ReadSessionContext 内部 lite 抽取请求",
      30000,
    );

    // 修复原因：这个 case 专门防止历史 30 秒协议请求判断或旧 45 秒工具 timeout
    // 把 ReadSessionContext 的长耗时内部抽取误判失败。第 46 秒仍应保持当前 turn running。
    await browser.pause(STILL_RUNNING_ASSERTION_DELAY_MS);
    const midRunSnapshot = await getChatRootSnapshot();
    expect(midRunSnapshot.state).toBe("streaming");
    expect(midRunSnapshot.queueCount).toBe(0);

    await waitForUpstreamRequest(
      {
        excludes: ["Generate a concise title"],
        includes: [TARGET_MARKER, SOURCE_MARKER],
      },
      "ReadSessionContext 工具结果没有进入后续主模型请求",
      120000,
    );
    await waitForAssistantMessageContaining(FINAL_MARKER);
    await waitForChatState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "ReadSessionContext timeout case 完成后没有回到 idle",
      120000,
    );

    const toolBlock = await waitForToolCallBlockByToolName(
      READ_SESSION_CONTEXT_TOOL_NAME,
      30000,
    );
    expect(toolBlock.exists).toBe(true);

    const liteRecord = await waitForReplayRecordByFixtureId(LITE_FIXTURE_ID);
    expect(liteRecord.status).toBe("complete");
    expect(liteRecord.durationMs ?? 0).toBeGreaterThanOrEqual(
      LITE_DELAY_MS - 1000,
    );
  });
});

async function seedReadSessionContextSourceSession() {
  await mkdir(DEFAULT_WORKSPACE, { recursive: true });
  const dbPath = join(homedir(), ".zcode", "cli", "db", "db.sqlite");
  await mkdir(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  const now = Date.now() - 10_000;

  try {
    db.exec("pragma foreign_keys = on; pragma busy_timeout = 5000;");
    // 修复原因：该 E2E 需要一个稳定的被引用历史 session；先让 app 初始化 sqlite schema，
    // 再按 session-store 的持久化格式写入最小 rows，避免测试包依赖 agent adapters 构建链路。
    db.prepare(
      `
      insert into session (
        id, project_id, workspace_id, parent_id, trace_id, task_type, slug, directory, path,
        title, title_source, title_message_id, version,
        share_url, summary_additions, summary_deletions, summary_files, summary_diffs,
        revert, permission, time_created, time_updated, time_title_updated,
        time_compacting, time_archived
      ) values (?, ?, null, null, ?, 'interactive', ?, ?, ?, ?, 'custom', null, 'e2e',
        null, null, null, null, null, null, ?, ?, ?, ?, null, null)
      on conflict(id) do update set
        project_id = excluded.project_id,
        trace_id = excluded.trace_id,
        task_type = excluded.task_type,
        slug = excluded.slug,
        directory = excluded.directory,
        path = excluded.path,
        title = excluded.title,
        title_source = excluded.title_source,
        version = excluded.version,
        permission = excluded.permission,
        time_title_updated = excluded.time_title_updated,
        time_updated = excluded.time_updated
      `,
    ).run(
      SOURCE_SESSION_ID,
      SOURCE_PROJECT_ID,
      SOURCE_TRACE_ID,
      "e2e-read-session-context-timeout-source",
      DEFAULT_WORKSPACE,
      DEFAULT_WORKSPACE,
      SOURCE_SESSION_TITLE,
      JSON.stringify({ mode: "build" }),
      now,
      now + 2,
      now + 2,
    );
    saveMessageRow(db, SOURCE_USER_MESSAGE_ID, now, now, {
      role: "user",
      time: { created: now },
      agent: "zcode-agent",
      model: { providerID: PROVIDER_ID, modelID: MODEL_ID },
      metadata: { e2eCase: CASE_NAME },
    });
    savePartRow(db, SOURCE_USER_PART_ID, SOURCE_USER_MESSAGE_ID, now, now, {
      type: "text",
      text: `${SOURCE_MARKER}: record the protocol timeout investigation and keep this context readable.`,
      time: { start: now, end: now },
      metadata: { e2eCase: CASE_NAME },
    });
    saveMessageRow(db, SOURCE_ASSISTANT_MESSAGE_ID, now + 1, now + 1, {
      role: "assistant",
      parentID: SOURCE_USER_MESSAGE_ID,
      time: { created: now + 1, completed: now + 1 },
      modelID: MODEL_ID,
      providerID: PROVIDER_ID,
      mode: "build",
      agent: "zcode-agent",
      path: { cwd: DEFAULT_WORKSPACE, root: DEFAULT_WORKSPACE },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      finish: "stop",
    });
    savePartRow(db, SOURCE_ASSISTANT_PART_ID, SOURCE_ASSISTANT_MESSAGE_ID, now + 1, now + 1, {
      type: "text",
      text: `${SOURCE_MARKER}: ReadSessionContext must survive a lite extraction that lasts longer than the historical 45 second tool timeout.`,
      time: { start: now + 1, end: now + 1 },
      metadata: { e2eCase: CASE_NAME },
    });
  } finally {
    db.close();
  }
}

function saveMessageRow(
  db: DatabaseSync,
  messageId: string,
  timeCreated: number,
  timeUpdated: number,
  data: Record<string, unknown>,
) {
  db.prepare(
    `
    insert into message (id, session_id, time_created, time_updated, data)
    values (?, ?, ?, ?, ?)
    on conflict(id) do update set
      session_id = excluded.session_id,
      time_updated = excluded.time_updated,
      data = excluded.data
    `,
  ).run(messageId, SOURCE_SESSION_ID, timeCreated, timeUpdated, JSON.stringify(data));
  touchSourceSession(db, timeUpdated);
}

function savePartRow(
  db: DatabaseSync,
  partId: string,
  messageId: string,
  timeCreated: number,
  timeUpdated: number,
  data: Record<string, unknown>,
) {
  db.prepare(
    `
    insert into part (id, message_id, session_id, time_created, time_updated, data)
    values (?, ?, ?, ?, ?, ?)
    on conflict(id) do update set
      message_id = excluded.message_id,
      session_id = excluded.session_id,
      time_updated = excluded.time_updated,
      data = excluded.data
    `,
  ).run(partId, messageId, SOURCE_SESSION_ID, timeCreated, timeUpdated, JSON.stringify(data));
  touchSourceSession(db, timeUpdated);
}

function touchSourceSession(db: DatabaseSync, timeUpdated: number) {
  db.prepare("update session set time_updated = max(time_updated, ?) where id = ?").run(
    timeUpdated,
    SOURCE_SESSION_ID,
  );
}

async function stopRunningTurnIfNeeded() {
  const snapshot = await getChatRootSnapshot().catch(() => null);
  if (!snapshot || snapshot.state !== "streaming") {
    return;
  }
  await clickChatStop();
  await waitForChatState(
    (nextSnapshot) => nextSnapshot.state !== "streaming",
    "ReadSessionContext timeout case 收尾后没有退出 streaming",
    30000,
  );
}

async function waitForReplayRecordByFixtureId(fixtureId: string) {
  let latest: ReplayRecord | null = null;
  await browser.waitUntil(
    async () => {
      latest =
        (await readReplayRecords()).find(
          (record) => record.replay?.fixtureId === fixtureId,
        ) ?? null;
      return latest?.status === "complete";
    },
    {
      timeout: 30000,
      timeoutMsg: `没有等到 replay fixture 完成: ${fixtureId}; latest=${JSON.stringify(latest)}`,
    },
  );
  return latest!;
}

async function readReplayRecords(): Promise<ReplayRecord[]> {
  const capturePath = process.env.E2E_PROVIDER_CAPTURE_PATH?.trim();
  if (!capturePath) {
    return [];
  }
  const artifact = JSON.parse(await readFile(capturePath, "utf-8")) as {
    records?: ReplayRecord[];
  };
  return artifact.records ?? [];
}

interface ReplayRecord {
  durationMs?: number;
  replay?: {
    fixtureId?: string;
  };
  status: "complete" | "error" | "pending";
}
