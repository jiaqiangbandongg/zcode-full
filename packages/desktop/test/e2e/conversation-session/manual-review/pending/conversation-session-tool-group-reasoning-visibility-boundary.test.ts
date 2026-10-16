import { rm } from "node:fs/promises";
import {
  clearAppData,
  seedSettings,
  waitForDefaultWorkspaceReady,
} from "../../../helpers/desktop-app.js";
import {
  listConversationToolGroups,
  toggleLatestConversationToolGroup,
  waitForConversationToolGroup,
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

const CASE_NAME = "conversation-session-tool-group-reasoning-visibility-boundary";
const CASE_MARKER = "E2E_TOOL_GROUP_REASONING_VISIBILITY_BOUNDARY";
const RUNTIME_ROOT = resolveE2ERuntimePath(CASE_NAME);
const FILE_PATH = resolveE2EToolPath(CASE_NAME, "reasoning.ts");

describe("TGE04 reasoning visibility grouping boundary", () => {
  before(async function () {
    this.timeout(150000);
    await seedSettings({
      messageStreamShowReasoning: false,
      messageStreamShowReasoningMigrationInitialized: true,
      toolGroupingChangesEnabled: true,
    });
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

  it("隐藏 reasoning 时合并，显示后按可见 reasoning 拆分", async function () {
    this.timeout(240000);
    await ensureToolCrossProductFullAccessMode();
    await sendV4Prompt([
      `${CASE_MARKER}: Think briefly before every numbered step, then follow all steps in order.`,
      `1. Bash: node -e "console.log('TGE04_EXEC_A')"`,
      `2. Bash: node -e "console.log('TGE04_EXEC_B')"`,
      `3. Write ${FILE_PATH} with exactly "export const reasoning = 'a';\\n".`,
      `4. Edit ${FILE_PATH}, replacing "'a'" with "'b'".`,
      `5. Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`,
    ].join(" "));
    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN, 150000);
    await waitForV4Pane((snapshot) => !snapshot.canStop, "reasoning boundary 工具轮没有结束", 150000);
    await expandAssistantHistoriesWithContent();

    const hiddenGroups = await listConversationToolGroups();
    expect(hiddenGroups.filter((group) => group.toolName === "ExecuteGroup")).toHaveLength(1);
    expect(hiddenGroups.filter((group) => group.toolName === "ChangesGroup")).toHaveLength(1);
    await toggleLatestConversationToolGroup("ExecuteGroup", true);
    await toggleLatestConversationToolGroup("ChangesGroup", true);
    const expandedHiddenGroups = await listConversationToolGroups();
    expect(
      expandedHiddenGroups.find((group) => group.toolName === "ExecuteGroup")
        ?.childCount,
    ).toBe(2);
    expect(
      expandedHiddenGroups.find((group) => group.toolName === "ChangesGroup")
        ?.childCount,
    ).toBe(2);

    const sessionId = (await getV4PaneSnapshot()).sessionId;
    if (!sessionId || sessionId === "draft") throw new Error("TGE04 缺少可恢复 sessionId");
    await seedSettings({ messageStreamShowReasoning: true });
    await reloadAndRestoreSession(sessionId);
    await expandAssistantHistoriesWithContent();

    await waitForConversationToolGroup(
      "ExecuteGroup",
      (group) => group.status === "completed",
      "显示 reasoning 后 Terminal 没有恢复",
    );
    const visibleGroups = await listConversationToolGroups();
    expect(visibleGroups.filter((group) => group.toolName === "ExecuteGroup").length).toBeGreaterThanOrEqual(2);
    expect(visibleGroups.filter((group) => group.toolName === "ChangesGroup").length).toBeGreaterThanOrEqual(2);
  });
});

async function reloadAndRestoreSession(sessionId: string) {
  await browser.reloadSession();
  await waitForRendererAfterReloadSession();
  await waitForDefaultWorkspaceReady(60000);
  await selectV4TaskById(sessionId);
  await waitForV4Pane(
    (snapshot) => snapshot.sessionId === sessionId,
    `TGE04 没有恢复 session ${sessionId}`,
    60000,
  );
  await waitForRestoredSessionStable(sessionId, "TGE04 cold restore 没有稳定显示原会话");
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
  }, { timeout: 30000, interval: 250, timeoutMsg: "TGE04 reload 后没有 renderer target" });
}
