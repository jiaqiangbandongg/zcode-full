import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  assertUpstreamRequestCapture,
  waitForUpstreamNetworkCapture,
  waitForUpstreamNetworkRequestStarted,
} from "../../../helpers/upstream-capture.js";
import {
  UPSTREAM_MODEL,
  UPSTREAM_PROVIDER_ID,
  UPSTREAM_SECONDARY_MODEL,
  ensureUpstreamModelForE2E,
  selectUpstreamModelById,
} from "../../../helpers/upstream-provider.js";
import {
  clearAppData,
  getE2EAppDataPaths,
} from "../../../helpers/desktop-app.js";
import {
  getChatRootSnapshot,
  prepareConversationE2E,
  sendPrompt,
  startNewTask,
  waitForChatState,
  waitForComposerText,
} from "../../../helpers/conversation-session.js";

const CASE_TIMEOUT_MS = 120_000;
const MAIN_MARKER = "E2E_RUNNING_MODEL_SWITCH_USAGE";
const EXPECTED_TOTAL_TOKENS = 132;

interface ModelUsageRow {
  computedTotalTokens: number;
  modelId: string;
  providerId: string;
  status: string;
}

describe("N16：普通流式响应中切模型的 usage 归属", () => {
  before(async function () {
    this.timeout(CASE_TIMEOUT_MS);

    await prepareConversationE2E();
    await ensureUpstreamModelForE2E(UPSTREAM_SECONDARY_MODEL);
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("当前请求完成后的 token 应归属实际执行模型，而不是切换后的 session 默认模型", async function () {
    this.timeout(CASE_TIMEOUT_MS);

    await startNewTask();
    await selectUpstreamModelById(UPSTREAM_MODEL);

    const marker = `${MAIN_MARKER}_${Date.now()}`;
    await sendPrompt(`${marker}: Reply with exactly "upstream-e2e-ok" and no other text.`);
    await waitForComposerText("", "N16 首轮发送后输入框没有清空");
    await waitForChatState(
      (snapshot) => snapshot.state === "streaming",
      "N16 首轮没有进入 streaming",
      30_000,
    );
    await waitForUpstreamNetworkRequestStarted(marker);

    const runningSnapshot = await getChatRootSnapshot();
    const sessionId = requireSessionId(runningSnapshot.sessionId);
    expect(runningSnapshot.state).toBe("streaming");

    await selectUpstreamModelById(UPSTREAM_SECONDARY_MODEL);
    expect((await getChatRootSnapshot()).state).toBe("streaming");

    const completedRequest = await waitForUpstreamNetworkCapture(marker);
    assertUpstreamRequestCapture(completedRequest, {
      expectedText: marker,
      model: UPSTREAM_MODEL,
    });
    await waitForChatState(
      (snapshot) => snapshot.state === "idle",
      "N16 旧模型请求没有完成",
      60_000,
    );

    const usage = await waitForMainTurnUsage(sessionId);
    expect(usage).toEqual({
      computedTotalTokens: EXPECTED_TOTAL_TOKENS,
      modelId: UPSTREAM_MODEL,
      providerId: UPSTREAM_PROVIDER_ID,
      status: "completed",
    });
  });
});

function requireSessionId(value: string | null): string {
  if (!value) {
    throw new Error("N16 streaming session 缺少 sessionId");
  }
  return value;
}

async function waitForMainTurnUsage(sessionId: string): Promise<ModelUsageRow> {
  let latest: ModelUsageRow | null = null;
  await browser.waitUntil(
    () => {
      latest = readMainTurnUsage(sessionId);
      return latest !== null;
    },
    {
      timeout: 30_000,
      timeoutMsg: `N16 没有读到 main_turn model_usage: sessionId=${sessionId}`,
    },
  );
  if (!latest) {
    throw new Error(`N16 main_turn model_usage 在等待完成后仍不存在: sessionId=${sessionId}`);
  }
  return latest;
}

function readMainTurnUsage(sessionId: string): ModelUsageRow | null {
  // Node 内置 SQLite 当前只提供同步只读接口；E2E 每次只读一行并立即关闭句柄。
  const database = new DatabaseSync(
    join(getE2EAppDataPaths().storageRoot, "cli", "db", "db.sqlite"),
    { readOnly: true },
  );
  try {
    return (
      (database
        .prepare(
          `select
             provider_id as providerId,
             model_id as modelId,
             status,
             computed_total_tokens as computedTotalTokens
           from model_usage
           where session_id = ? and query_source = 'main_turn'
           order by started_at desc
           limit 1`,
        )
        .get(sessionId) as ModelUsageRow | undefined) ?? null
    );
  } finally {
    database.close();
  }
}
