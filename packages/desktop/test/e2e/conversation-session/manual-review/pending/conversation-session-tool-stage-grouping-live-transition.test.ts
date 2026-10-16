import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clearAppData, seedSettings } from "../../../helpers/desktop-app.js";
import {
  listConversationToolGroups,
  toggleLatestConversationToolGroup,
  waitForConversationToolGroup,
} from "../../../helpers/conversation-session-tool-groups.js";
import {
  ensureToolCrossProductFullAccessMode,
  respondToToolCrossProductBlockers,
} from "../../../helpers/conversation-session-tool-cross-product.js";
import {
  resolveE2ERuntimePath,
  resolveE2EShellPath,
  resolveE2EToolPath,
} from "../../../helpers/e2e-runtime-paths.js";
import {
  E2E_REPLY_TOKEN,
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4Prompt,
  switchV4Mode,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
} from "../../../helpers/v4-conversation.js";
import { expandAssistantHistoriesWithContent } from "../../../helpers/conversation-session-tool-diagnostics.js";

const CASE_NAME = "conversation-session-tool-stage-grouping-live-transition";
const CASE_MARKER = "E2E_TOOL_STAGE_GROUPING_LIVE_TRANSITION";
const RUNTIME_ROOT = resolveE2ERuntimePath(CASE_NAME);
const READ_PATH = resolveE2EToolPath(CASE_NAME, "seed.txt");
const WRITE_PATH = resolveE2EToolPath(CASE_NAME, "result.ts");
const SHELL_READ_PATH = resolveE2EShellPath(CASE_NAME, "seed.txt");

describe("TGE01 tool stage grouping live transition", () => {
  before(async function () {
    this.timeout(150000);
    await seedSettings({ toolGroupingChangesEnabled: true });
    await prepareV4ConversationE2E();
    await switchV4Mode("yolo");
  });

  afterEach(async () => {
    await stopIfBusy();
    await rm(RUNTIME_ROOT, { recursive: true, force: true });
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("按可见阶段依次收敛 Explore、Terminal 与 Changes", async function () {
    this.timeout(180000);
    await prepareFixture();
    await ensureToolCrossProductFullAccessMode();

    await sendV4Prompt([
      `${CASE_MARKER}: Follow every tool step in order.`,
      `1. Read exactly ${READ_PATH}.`,
      `2. Use Bash with exactly: wc -l ${SHELL_READ_PATH}`,
      `3. Use Bash with exactly: node -e "setTimeout(() => console.log('TGE01_EXEC_A'), 1200)"`,
      `4. Use Bash with exactly: node -e "console.log('TGE01_EXEC_B')"`,
      `5. Use Write to create ${WRITE_PATH} with exactly "export const stage = 'written';\\n".`,
      `6. Use Edit on ${WRITE_PATH} to replace "written" with "edited".`,
      `7. Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`,
    ].join(" "));

    await waitForConversationToolGroup(
      "Explore",
      (group) => group.status === "in_progress",
      "Read/readonly 阶段没有保持 Explore 进行中",
      90000,
    );
    await waitForConversationToolGroup(
      "ExecuteGroup",
      (group) => group.status === "in_progress" && group.summaryText.includes("TGE01_EXEC"),
      "mutating Shell 没有进入运行中的 Terminal",
      90000,
    );
    await waitForConversationToolGroup(
      "ChangesGroup",
      (group) => group.status === "in_progress" && /Writing|Editing|写入|编辑/u.test(group.summaryText),
      "Write/Edit 没有进入运行中的 Changes",
      90000,
    );
    await waitForTurnIdle();
    await expandAssistantHistoriesWithContent();

    await toggleLatestConversationToolGroup("Explore", true);
    await toggleLatestConversationToolGroup("ExecuteGroup", true);
    await toggleLatestConversationToolGroup("ChangesGroup", true);

    const groups = await listConversationToolGroups();
    expect(groups.map((group) => group.toolName)).toEqual([
      "Explore",
      "ExecuteGroup",
      "ChangesGroup",
    ]);
    expect(groups.every((group) => group.status === "completed")).toBe(true);
    expect(groups[0]?.childCount).toBe(2);
    expect(groups[1]?.childCount).toBe(2);
    expect(groups[2]?.childCount).toBe(2);
  });
});

async function prepareFixture() {
  await rm(RUNTIME_ROOT, { recursive: true, force: true });
  await mkdir(RUNTIME_ROOT, { recursive: true });
  await writeFile(join(RUNTIME_ROOT, "seed.txt"), "alpha\nbeta\n", "utf8");
}

async function waitForTurnIdle() {
  await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN, 120000);
  await waitForV4Pane(
    (snapshot) => !snapshot.canStop,
    "TGE01 工具轮没有结束",
    120000,
  );
}

async function stopIfBusy() {
  const pane = await getV4PaneSnapshot().catch(() => null);
  if (!pane?.canStop) return;
  await browser.keys(["ESCAPE"]);
  await browser.waitUntil(async () => !(await getV4PaneSnapshot()).canStop, {
    timeout: 30000,
    timeoutMsg: "TGE01 cleanup 没有退出运行态",
  });
  await respondToToolCrossProductBlockers();
}
