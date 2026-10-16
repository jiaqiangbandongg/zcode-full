import { readFile } from "node:fs/promises";
import {
  TID_CHAT_MODEL_SELECT_GROUP,
  TID_CHAT_MODEL_SELECT_ITEM,
  TID_CHAT_MODEL_SELECT_TRIGGER,
  TID_V4_STOP,
  encodeCustomModelValue,
  testId,
} from "@zcode/shared";
import { clearAppData, clickTestIdByDom } from "../../../helpers/desktop-app.js";
import {
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4PromptAndWaitAccepted,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
  waitForV4TimelineContaining,
} from "../../../helpers/v4-conversation.js";
import { waitForToolCallBlockByToolName } from "../../../helpers/conversation-session-tool.js";
import {
  restartIntoWorkspace,
  seedReplayProvider,
} from "../../../helpers/model-provider-restart.js";
import { sel } from "../../../helpers/selectors.js";

const START_PROVIDER_ID = "e2e-start-subagent-boundary";
const START_MODEL_ID = "start-subagent-boundary-model";
const CODING_PROVIDER_ID = "e2e-coding-subagent-boundary";
const CODING_MODEL_ID = "coding-subagent-boundary-model";

const BOUNDARY_PARENT = "E2E_SUBAGENT_MODEL_BOUNDARY_PARENT";
const BOUNDARY_CHILD = "E2E_SUBAGENT_MODEL_BOUNDARY_CHILD";
const BOUNDARY_PARENT_DONE = "E2E_SUBAGENT_MODEL_BOUNDARY_PARENT_DONE";
const NESTED_PARENT = "E2E_SUBAGENT_NESTED_PARENT";
const NESTED_CHILD = "E2E_SUBAGENT_NESTED_CHILD";
const NESTED_GRANDCHILD = "E2E_SUBAGENT_NESTED_GRANDCHILD";
const NESTED_GRANDCHILD_DONE = "E2E_SUBAGENT_NESTED_GRANDCHILD_DONE";
const NESTED_CHILD_DONE = "E2E_SUBAGENT_NESTED_CHILD_DONE";
const NESTED_PARENT_DONE = "E2E_SUBAGENT_NESTED_PARENT_DONE";

interface CaptureRecord {
  requestJson?: unknown;
  status?: string;
}

describe("Subagent 模型快照边界 E2E", () => {
  afterEach(async () => {
    try {
      const pane = await getV4PaneSnapshot();
      if (pane.canStop) {
        await clickTestIdByDom(TID_V4_STOP, { timeout: 3000 }).catch(() => undefined);
      }
    } catch {
      // 清理失败不覆盖原始断言。
    }
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("F-SUBAGENT-013/F-SUBAGENT-016: child 在途期间父会话切换计划仍使用创建时快照", async function () {
    this.timeout(300000);
    await prepareV4ConversationE2E({ skipProvider: true });
    await seedReplayProvider({
      id: START_PROVIDER_ID,
      models: [START_MODEL_ID],
      name: "E2E Start Plan Subagent Boundary",
    });
    await seedReplayProvider({
      id: CODING_PROVIDER_ID,
      models: [CODING_MODEL_ID],
      name: "E2E Coding Plan Subagent Boundary",
    });
    await restartIntoWorkspace();
    await prepareV4ConversationE2E({ skipProvider: true });
    await selectV4ModelOnly(START_PROVIDER_ID, START_MODEL_ID);

    const runId = Date.now();
    const parentMarker = `${BOUNDARY_PARENT}_${runId}`;
    await sendV4PromptAndWaitAccepted(
      `${parentMarker}: launch one general-purpose Agent for ${BOUNDARY_CHILD}; after it returns reply exactly ${BOUNDARY_PARENT_DONE}.`,
      parentMarker,
      "父会话没有接受 subagent boundary prompt",
    );
    await waitForV4TimelineContaining(parentMarker, 30000);
    await waitForToolCallBlockByToolName("Agent", 30000);

    // Agent tool 已出现在父 timeline 后，child runtime 已被创建；此时切换父 draft
    // 到 Coding Plan，不能改写 child 已捕获的 Start Plan execution snapshot。
    await selectV4ModelOnly(CODING_PROVIDER_ID, CODING_MODEL_ID);
    await waitForV4AssistantMessageContaining(BOUNDARY_PARENT_DONE, 120000);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "subagent boundary case 完成后没有回到 idle",
      120000,
    );

    const child = await waitForCaptureRequest(BOUNDARY_CHILD);
    expect(readModel(child.requestJson)).toBe(START_MODEL_ID);
    const parentRequests = await readCaptureRecords(parentMarker);
    expect(parentRequests.some((record) => readModel(record.requestJson) === CODING_MODEL_ID)).toBe(
      true,
    );
  });

  it("F-SUBAGENT-018: 三层 Subagent 只沿直接父级继承模型身份", async function () {
    this.timeout(240000);
    await prepareV4ConversationE2E({ skipProvider: true });
    await seedReplayProvider({
      id: START_PROVIDER_ID,
      models: [START_MODEL_ID],
      name: "E2E Start Plan Nested Subagent",
    });
    await restartIntoWorkspace();
    await prepareV4ConversationE2E({ skipProvider: true });
    await selectV4ModelOnly(START_PROVIDER_ID, START_MODEL_ID);

    const runId = Date.now();
    const parentMarker = `${NESTED_PARENT}_${runId}`;
    await sendV4PromptAndWaitAccepted(
      `${parentMarker}: launch a child Agent for ${NESTED_CHILD}; after it returns reply exactly ${NESTED_PARENT_DONE}.`,
      parentMarker,
      "nested subagent 父会话没有接受 prompt",
    );
    await waitForV4AssistantMessageContaining(NESTED_PARENT_DONE, 120000);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "nested subagent 完成后没有回到 idle",
      120000,
    );

    for (const marker of [NESTED_CHILD, NESTED_GRANDCHILD]) {
      const request = await waitForCaptureRequest(marker);
      expect(readModel(request.requestJson)).toBe(START_MODEL_ID);
    }
    expect((await readCaptureRecords(parentMarker)).length).toBeGreaterThanOrEqual(2);
    expect(await readCaptureRecords(NESTED_GRANDCHILD_DONE)).toHaveLength(1);
    expect(await readCaptureRecords(NESTED_CHILD_DONE)).toHaveLength(1);
  });
});

async function selectV4ModelOnly(provider: string, model: string): Promise<void> {
  const value = encodeCustomModelValue(provider, model);
  const trigger = $(sel(TID_CHAT_MODEL_SELECT_TRIGGER));
  await trigger.waitForClickable({ timeout: 30000 });
  await trigger.click();
  const item = $(sel(testId(TID_CHAT_MODEL_SELECT_ITEM, value)));
  const group = $(sel(testId(TID_CHAT_MODEL_SELECT_GROUP, `registry-provider:${provider}`)));
  if (!(await item.isExisting())) {
    await group.waitForDisplayed({ timeout: 30000 });
    await group.click();
  }
  await item.waitForDisplayed({ timeout: 30000 });
  await item.click();
  await browser.waitUntil(
    async () =>
      (await $(sel(TID_CHAT_MODEL_SELECT_TRIGGER)).getAttribute("data-model-current-value")) ===
      value,
    { timeout: 30000, timeoutMsg: `没有切换到 ${provider}/${model}` },
  );
}

async function waitForCaptureRequest(marker: string): Promise<CaptureRecord> {
  let records: CaptureRecord[] = [];
  await browser.waitUntil(
    async () => {
      records = await readCaptureRecords(marker);
      return records.length > 0;
    },
    { timeout: 120000, interval: 500, timeoutMsg: `没有捕获到 subagent 请求 ${marker}` },
  );
  const record = records.at(-1);
  if (!record) throw new Error(`capture 中缺少 ${marker}`);
  return record;
}

async function readCaptureRecords(marker: string): Promise<CaptureRecord[]> {
  const path = process.env.E2E_PROVIDER_CAPTURE_PATH?.trim();
  if (!path) return [];
  try {
    const artifact = JSON.parse(await readFile(path, "utf8")) as { records?: CaptureRecord[] };
    return (artifact.records ?? []).filter((record) =>
      JSON.stringify(record.requestJson).includes(marker),
    );
  } catch {
    return [];
  }
}

function readModel(requestJson: unknown): string | null {
  if (!requestJson || typeof requestJson !== "object" || Array.isArray(requestJson)) return null;
  const model = (requestJson as { model?: unknown }).model;
  return typeof model === "string" ? model : null;
}
