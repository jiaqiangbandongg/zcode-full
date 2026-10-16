import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  clearAppData,
  seedSettings,
  waitForDefaultWorkspaceReady,
} from "../../../helpers/desktop-app.js";
import {
  listConversationToolGroups,
  type ConversationToolGroupSnapshot,
} from "../../../helpers/conversation-session-tool-groups.js";
import { ensureToolCrossProductFullAccessMode } from "../../../helpers/conversation-session-tool-cross-product.js";
import {
  resolveE2ERuntimePath,
  resolveE2EToolPath,
} from "../../../helpers/e2e-runtime-paths.js";
import {
  E2E_REPLY_TOKEN,
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  switchV4Mode,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
} from "../../../helpers/v4-conversation.js";
import { expandAssistantHistoriesWithContent } from "../../../helpers/conversation-session-tool-diagnostics.js";

const CASE_NAME = "conversation-session-tool-groups-history-restore";
const CASE_MARKER = "E2E_TOOL_GROUPS_HISTORY_RESTORE";
const RUNTIME_ROOT = resolveE2ERuntimePath(CASE_NAME);
const READ_PATH = resolveE2EToolPath(CASE_NAME, "read.txt");
const WRITE_PATH = resolveE2EToolPath(CASE_NAME, "write.ts");

describe("TGE05 desktop tool groups history restore", () => {
  before(async function () {
    this.timeout(150000);
    await seedSettings({ toolGroupingChangesEnabled: true });
    await prepareV4ConversationE2E();
    await switchV4Mode("yolo");
  });

  afterEach(async () => {
    await rm(RUNTIME_ROOT, { recursive: true, force: true });
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("完整冷重启后保持 Explore、Terminal、Changes 的终态和顺序", async function () {
    this.timeout(240000);
    await prepareFixture();
    await ensureToolCrossProductFullAccessMode();
    await sendV4Prompt([
      `${CASE_MARKER}: Follow these tool steps in order.`,
      `1. Read ${READ_PATH}.`,
      `2. Bash exactly: node -e "console.log('TGE05_EXEC')"`,
      `3. Write ${WRITE_PATH} with exactly "export const restored = true;\\n".`,
      `4. Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`,
    ].join(" "));
    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN, 150000);
    await waitForV4Pane((snapshot) => !snapshot.canStop, "TGE05 工具轮没有结束", 150000);
    await expandAssistantHistoriesWithContent();
    const liveGroups = await waitForThreeCompletedGroups();

    const sessionId = (await getV4PaneSnapshot()).sessionId;
    if (!sessionId || sessionId === "draft") throw new Error("TGE05 缺少 sessionId");
    await reloadAndRestoreSession(sessionId);
    await expandAssistantHistoriesWithContent();
    const restoredGroups = await waitForThreeCompletedGroups();

    expect(toStableGroupEvidence(restoredGroups)).toEqual(toStableGroupEvidence(liveGroups));
    expect((await getV4PaneSnapshot()).sessionId).toBe(sessionId);
  });
});

async function prepareFixture() {
  await rm(RUNTIME_ROOT, { recursive: true, force: true });
  await mkdir(RUNTIME_ROOT, { recursive: true });
  await writeFile(join(RUNTIME_ROOT, "read.txt"), "TGE05_READ\n", "utf8");
}

async function waitForThreeCompletedGroups() {
  let latest: ConversationToolGroupSnapshot[] = [];
  await browser.waitUntil(async () => {
    latest = await listConversationToolGroups();
    return latest.length === 3 && latest.every((group) => group.status === "completed");
  }, { timeout: 60000, timeoutMsg: `TGE05 没有得到三个完成分组: ${JSON.stringify(latest)}` });
  return latest;
}

function toStableGroupEvidence(groups: ConversationToolGroupSnapshot[]) {
  return groups.map((group) => ({
    childCount: group.childCount,
    status: group.status,
    summaryText: group.summaryText,
    toolName: group.toolName,
  }));
}

async function reloadAndRestoreSession(sessionId: string) {
  await browser.reloadSession();
  await waitForRendererAfterReloadSession();
  await waitForDefaultWorkspaceReady(60000);
  await selectV4TaskById(sessionId);
  await waitForV4Pane(
    (snapshot) => snapshot.sessionId === sessionId,
    `TGE05 没有恢复 session ${sessionId}`,
    60000,
  );
  await waitForRestoredSessionStable(sessionId, "TGE05 cold restore 没有稳定显示原会话");
}

async function waitForRestoredSessionStable(sessionId: string, failureMessage: string) {
  let stableSince = 0;
  await browser.waitUntil(
    async () => {
      const snapshot = await getV4PaneSnapshot();
      const matches =
        snapshot.sessionId === sessionId && snapshot.timelineText.includes(E2E_REPLY_TOKEN);
      if (!matches) {
        stableSince = 0;
        return false;
      }
      stableSince ||= Date.now();
      return Date.now() - stableSince >= 1000;
    },
    { timeout: 60000, timeoutMsg: failureMessage },
  );
}

async function waitForRendererAfterReloadSession() {
  await browser.waitUntil(async () => {
    try {
      const puppeteer = await browser.getPuppeteer();
      const rendererTarget = puppeteer.targets().filter((target) => target.url().includes("/renderer/index.html")).at(-1);
      const targetId = rendererTarget ? (rendererTarget as unknown as { _targetId?: string })._targetId : null;
      if (!targetId) return false;
      await browser.switchToWindow(targetId);
      return true;
    } catch {
      return false;
    }
  }, { timeout: 30000, interval: 250, timeoutMsg: "TGE05 reload 后没有 renderer target" });
}
