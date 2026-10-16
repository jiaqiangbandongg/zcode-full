import { readFile, rm } from "node:fs/promises";
import { clearAppData, seedSettings } from "../../../helpers/desktop-app.js";
import {
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
  prepareV4ConversationE2E,
  sendV4Prompt,
  switchV4Mode,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
} from "../../../helpers/v4-conversation.js";

const CASE_NAME = "conversation-session-changes-group-unresolved-path";
const CASE_MARKER = "E2E_CHANGES_GROUP_UNRESOLVED_PATH";
const RUNTIME_ROOT = resolveE2ERuntimePath(CASE_NAME);
const WRITE_PATH = resolveE2EToolPath(CASE_NAME, "App.tsx");

describe("TGE07 Changes unresolved path and single-file summary", () => {
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

  it("路径未到达时显示 tool 数，展开保留 Writing；路径到达后切换文件摘要", async function () {
    this.timeout(180000);
    await ensureToolCrossProductFullAccessMode();
    await sendV4Prompt(
      `${CASE_MARKER}: Write ${WRITE_PATH}, then reply with exactly "${E2E_REPLY_TOKEN}".`,
    );

    const unresolved = await waitForConversationToolGroup(
      "ChangesGroup",
      (group) =>
        group.status === "in_progress" &&
        /1 tool|1 个工具/u.test(group.summaryText),
      "Changes 在 file_path 到达前没有显示 1 tool",
      60000,
    );
    expect(unresolved.summaryText).not.toMatch(/0 files?|0 个文件/u);
    const expanded = await toggleLatestConversationToolGroup(
      "ChangesGroup",
      true,
    );
    expect(expanded.text).toMatch(/Writing|写入/u);

    await waitForConversationToolGroup(
      "ChangesGroup",
      (group) =>
        group.status === "in_progress" && group.summaryText.includes("App.tsx"),
      "file_path 到达后 Changes 没有切换为文件摘要",
      60000,
    );
    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN, 120000);
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop,
      "TGE07 工具轮没有结束",
      120000,
    );
    expect(await readFile(WRITE_PATH, "utf8")).toBe(
      "export const app = true;\n",
    );

    const collapsed = await toggleLatestConversationToolGroup(
      "ChangesGroup",
      false,
    );
    expect(collapsed.summaryText).toContain("App.tsx");
    expect(collapsed.summaryText).not.toMatch(/1 file|1 个文件/u);
  });
});
