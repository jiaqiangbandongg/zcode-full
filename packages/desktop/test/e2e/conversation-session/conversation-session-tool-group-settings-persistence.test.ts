import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared";
import { clearAppData, clickTestIdByDom, readSettings } from "../helpers/desktop-app.js";
import { listConversationToolGroups } from "../helpers/conversation-session-tool-groups.js";
import { ensureToolCrossProductFullAccessMode } from "../helpers/conversation-session-tool-cross-product.js";
import { resolveE2ERuntimePath, resolveE2EToolPath } from "../helpers/e2e-runtime-paths.js";
import {
  E2E_REPLY_TOKEN,
  prepareV4ConversationE2E,
  sendV4Prompt,
  switchV4Mode,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
} from "../helpers/v4-conversation.js";
import { expandAssistantHistoriesWithContent } from "../helpers/conversation-session-tool-diagnostics.js";

const CASE_NAME = "conversation-session-tool-group-settings-persistence";
const CASE_MARKER = "E2E_TOOL_GROUP_SETTINGS_PERSISTENCE";
const RUNTIME_ROOT = resolveE2ERuntimePath(CASE_NAME);
const READ_PATHS = [
  resolveE2EToolPath(CASE_NAME, "seed-a.txt"),
  resolveE2EToolPath(CASE_NAME, "seed-b.txt"),
] as const;
const WRITE_PATHS = [
  resolveE2EToolPath(CASE_NAME, "result-a.ts"),
  resolveE2EToolPath(CASE_NAME, "result-b.ts"),
] as const;

const GROUP_SWITCH_LABELS = {
  explore: ["Group exploration tools", "分组探索工具"],
  terminal: ["Group terminal commands", "分组终端命令"],
  changes: ["Group file changes", "分组文件更改"],
} as const;

type GroupSwitch = keyof typeof GROUP_SWITCH_LABELS;

describe("TGE06 tool group settings defaults and persistence", () => {
  before(async function () {
    this.timeout(150000);
    await clearAppData();
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

  it("验证默认值、独立切换、历史重分组与持久化", async function () {
    this.timeout(240000);
    await prepareFixture();
    await openGeneralSettings();
    expect(await readGroupSwitch("explore")).toBe(true);
    expect(await readGroupSwitch("terminal")).toBe(true);
    expect(await readGroupSwitch("changes")).toBe(false);
    await setGroupSwitch("changes", true);
    await leaveSettings();

    await ensureToolCrossProductFullAccessMode();
    await sendV4Prompt(
      [
        `${CASE_MARKER}: Follow these tool steps exactly in order.`,
        `1. Read ${READ_PATHS[0]} and ${READ_PATHS[1]}.`,
        `2. Bash exactly: node -e "console.log('TGE06_TERMINAL_A')" and node -e "console.log('TGE06_TERMINAL_B')".`,
        `3. Write ${WRITE_PATHS[0]} and ${WRITE_PATHS[1]} with exactly "export const grouped = true;\\n".`,
        `4. Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`,
      ].join(" "),
    );
    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN, 150000);
    await waitForV4Pane((snapshot) => !snapshot.canStop, "TGE06 工具轮没有结束", 150000);
    await expandAssistantHistoriesWithContent();
    await waitForGroupNames(["Explore", "ExecuteGroup", "ChangesGroup"]);

    await openGeneralSettings();
    await setGroupSwitch("explore", false);
    await leaveSettings();
    await waitForGroupNames(["ExecuteGroup", "ChangesGroup"]);

    await openGeneralSettings();
    await setGroupSwitch("terminal", false);
    await leaveSettings();
    await waitForGroupNames(["ChangesGroup"]);

    await openGeneralSettings();
    expect(await readGroupSwitch("explore")).toBe(false);
    expect(await readGroupSwitch("terminal")).toBe(false);
    expect(await readGroupSwitch("changes")).toBe(true);
    expect(await readSettings()).toMatchObject({
      toolGroupingExploreEnabled: false,
      toolGroupingTerminalEnabled: false,
      toolGroupingChangesEnabled: true,
    });
  });
});

async function prepareFixture() {
  await rm(RUNTIME_ROOT, { recursive: true, force: true });
  await mkdir(RUNTIME_ROOT, { recursive: true });
  await Promise.all([
    writeFile(join(RUNTIME_ROOT, "seed-a.txt"), "TGE06_READ_A\n", "utf8"),
    writeFile(join(RUNTIME_ROOT, "seed-b.txt"), "TGE06_READ_B\n", "utf8"),
  ]);
}

async function openGeneralSettings() {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, { timeout: 15000 });
  await browser.waitUntil(
    () =>
      browser.execute(
        (id) => Boolean(document.querySelector(`[data-testid="${id}"]`)),
        TID_SETTINGS_PAGE,
      ),
    { timeout: 15000, timeoutMsg: "TGE06 设置页没有打开" },
  );
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "general"), {
    timeout: 15000,
  });
  await browser.waitUntil(async () => (await readGroupSwitch("explore")) !== null, {
    timeout: 15000,
    timeoutMsg: "TGE06 常规设置没有工具分组开关",
  });
}

async function leaveSettings() {
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, { timeout: 15000 });
}

async function readGroupSwitch(name: GroupSwitch): Promise<boolean | null> {
  return browser.execute(
    (labels) => {
      const control = labels
        .map((label) => document.querySelector<HTMLElement>(`[aria-label="${label}"]`))
        .find(Boolean);
      if (!control) return null;
      return (
        control.getAttribute("aria-checked") === "true" ||
        control.getAttribute("data-state") === "checked"
      );
    },
    [...GROUP_SWITCH_LABELS[name]],
  );
}

async function setGroupSwitch(name: GroupSwitch, enabled: boolean) {
  if ((await readGroupSwitch(name)) !== enabled) {
    const clicked = await browser.execute(
      (labels) => {
        const control = labels
          .map((label) => document.querySelector<HTMLElement>(`[aria-label="${label}"]`))
          .find(Boolean);
        control?.click();
        return Boolean(control);
      },
      [...GROUP_SWITCH_LABELS[name]],
    );
    expect(clicked).toBe(true);
  }
  await browser.waitUntil(async () => (await readGroupSwitch(name)) === enabled, {
    timeout: 15000,
    timeoutMsg: `TGE06 ${name} 开关没有变为 ${String(enabled)}`,
  });
}

async function waitForGroupNames(expected: string[]) {
  let latest: string[] = [];
  await browser.waitUntil(
    async () => {
      latest = (await listConversationToolGroups()).map((group) => group.toolName);
      return JSON.stringify(latest) === JSON.stringify(expected);
    },
    {
      timeout: 15000,
      timeoutMsg: `TGE06 分组未更新: ${JSON.stringify(latest)}`,
    },
  );
}
