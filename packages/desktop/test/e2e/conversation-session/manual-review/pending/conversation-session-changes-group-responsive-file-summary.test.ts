import { readFile, rm } from "node:fs/promises";
import { TID_PREVIEW_PANE } from "@zcode/shared";
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
  setV4ElectronWindowSize,
  switchV4Mode,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
} from "../../../helpers/v4-conversation.js";
import { expandAssistantHistoriesWithContent } from "../../../helpers/conversation-session-tool-diagnostics.js";

const CASE_NAME = "conversation-session-changes-group-responsive-file-summary";
const CASE_MARKER = "E2E_CHANGES_GROUP_RESPONSIVE_FILE_SUMMARY";
const RUNTIME_ROOT = resolveE2ERuntimePath(CASE_NAME);
const FILES = ["App.tsx", "styles.css", "package.json", "notes.md"] as const;

describe("TGE03 Changes responsive file summary", () => {
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

  it("去重文件并随 summary 宽度显示全部 chips 或 +N", async function () {
    this.timeout(180000);
    await ensureToolCrossProductFullAccessMode();
    const paths = FILES.map((name) => resolveE2EToolPath(CASE_NAME, name));
    await sendV4Prompt([
      `${CASE_MARKER}: Follow these file tool steps exactly in order.`,
      ...paths.map((path, index) =>
        `${index + 1}. Use Write to create ${path} with exactly "TGE03_${index}\\n".`,
      ),
      `5. Use Edit on ${paths[0]} to replace "TGE03_0" with "TGE03_EDITED".`,
      `6. Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`,
    ].join(" "));

    await waitForConversationToolGroup(
      "ChangesGroup",
      (group) => group.status === "in_progress" && /Writing|Editing|写入|编辑/u.test(group.summaryText),
      "Changes 没有显示运行文件摘要",
      90000,
    );
    const runningExpanded = await toggleLatestConversationToolGroup("ChangesGroup", true);
    expect(runningExpanded.summaryText).toMatch(/\b\d+ files?\b|\d+ 个文件/u);
    expect(runningExpanded.summaryText).not.toMatch(/Writing|Editing|写入|编辑/u);

    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN, 120000);
    await waitForV4Pane((snapshot) => !snapshot.canStop, "Changes 工具轮没有结束", 120000);
    for (const [index, path] of paths.entries()) {
      const expected = index === 0 ? "TGE03_EDITED\n" : `TGE03_${index}\n`;
      expect(await readFile(path, "utf8")).toBe(expected);
    }
    await expandAssistantHistoriesWithContent();
    await toggleLatestConversationToolGroup("ChangesGroup", false);

    try {
      await setV4ElectronWindowSize(1400, 800);
      const wide = await waitForConversationToolGroup(
        "ChangesGroup",
        (group) =>
          group.status === "completed" &&
          (group.summaryText.includes("4 files") ||
            group.summaryText.includes("4 个文件")),
        "Changes 完成摘要没有显示 4 个唯一文件",
      );
      for (const file of FILES) expect(wide.summaryText).toContain(file);
      expect(wide.summaryText).not.toMatch(/\+\d+/u);

      await setV4ElectronWindowSize(430, 700);
      const narrow = await waitForConversationToolGroup(
        "ChangesGroup",
        (group) => /\+\d+/u.test(group.summaryText),
        "窄窗口 Changes 没有显示 +N",
      );
      expect(narrow.summaryText).toContain("App.tsx");

      await setV4ElectronWindowSize(1400, 800);
      await waitForConversationToolGroup(
        "ChangesGroup",
        (group) => FILES.every((file) => group.summaryText.includes(file)),
        "窗口变宽后没有恢复全部文件 chips",
      );
      await clickChangesFileChip("App.tsx");
      await browser.waitUntil(
        () => browser.execute((testId) => Boolean(document.querySelector(`[data-testid="${testId}"]`)), TID_PREVIEW_PANE),
        { timeout: 10000, timeoutMsg: "点击 Changes file chip 后没有打开 preview pane" },
      );
    } finally {
      await setV4ElectronWindowSize(1280, 800);
    }
  });
});

async function clickChangesFileChip(fileName: string) {
  const clicked = await browser.execute((name) => {
    const group = Array.from(document.querySelectorAll<HTMLElement>('[data-tool-name="ChangesGroup"]')).at(-1);
    const button = Array.from(group?.querySelectorAll<HTMLButtonElement>("button") ?? []).find((candidate) => candidate.innerText.includes(name));
    button?.click();
    return Boolean(button);
  }, fileName);
  expect(clicked).toBe(true);
}
