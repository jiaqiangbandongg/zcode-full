import { getUpstreamRequestEvidence } from "../helpers/conversation-session-network.js";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  TID_WORKSPACE_FILE_TREE_BUTTON,
  TID_WORKSPACE_ITEM,
  TID_WORKSPACE_FILE_TREE_ROW,
  TID_V4_COMPOSER_INPUT,
  TID_V4_SESSION_PANE,
  testId,
} from "@zcode/shared";
import { clearAppData, clickTestIdByDom, DEFAULT_WORKSPACE } from "../helpers/desktop-app.js";
import { resolveE2ERuntimePath } from "../helpers/e2e-runtime-paths.js";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4TimelineContaining,
} from "../helpers/v4-conversation.js";

const filePath = resolveE2ERuntimePath("markdown-preview-selection", "selection.md");
const marker = "E2E_MARKDOWN_PREVIEW_SELECTED_PARAGRAPH";
describe("Markdown preview selection", () => {
  after(async () => {
    await rm(dirname(filePath), { recursive: true, force: true });
    await clearAppData();
  });
  it("MPS01/02/06/08/09: 预览选区加入草稿，去重、移除且不自动发送", async function () {
    this.timeout(120000);
    await prepareV4ConversationE2E();
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, `# Preview\n\n${marker}\n`, "utf8");
    // 工作区行的操作按真实 hover 挂载；外层容器不保证可 focus，不能用 DOM focus 代替手势。
    const workspaceRow = await $(
      `[data-testid="${testId(TID_WORKSPACE_ITEM, DEFAULT_WORKSPACE)}"]`,
    );
    await workspaceRow.waitForDisplayed({ timeout: 15000 });
    await workspaceRow.moveTo();
    await browser
      .waitUntil(
        async () =>
          browser.execute(
            (actionId) => {
              return Boolean(document.querySelector(`[data-testid="${actionId}"]`));
            },
            testId(TID_WORKSPACE_FILE_TREE_BUTTON, DEFAULT_WORKSPACE),
          ),
        { timeout: 5000, timeoutMsg: "Workspace file tree action did not mount after hover" },
      )
      .catch(async (error) => {
        if (process.env.ZCODE_E2E_ARTIFACT_DIR) {
          await browser.saveScreenshot(
            join(process.env.ZCODE_E2E_ARTIFACT_DIR, "markdown-file-tree-unavailable.png"),
          );
        }
        console.log(
          "[MPS workspace entry]",
          await browser.execute(() =>
            Array.from(document.querySelectorAll<HTMLElement>("[data-testid]"))
              .filter((element) =>
                /workspace|file-tree|sidebar|project/.test(element.dataset.testid ?? ""),
              )
              .map((element) => ({
                id: element.dataset.testid,
                text: element.innerText.slice(0, 100),
              })),
          ),
        );
        throw error;
      });
    await clickTestIdByDom(testId(TID_WORKSPACE_FILE_TREE_BUTTON, DEFAULT_WORKSPACE));
    // 文件树会将单子目录链压缩为一行，入口使用压缩后的最深目录。
    for (const path of [dirname(filePath), filePath]) {
      const row = await $(`[data-testid="${testId(TID_WORKSPACE_FILE_TREE_ROW, path)}"]`);
      await row.waitForDisplayed({ timeout: 15000 });
      await row.click();
    }
    const preview = await $("[data-markdown-preview]");
    await preview.waitForDisplayed({ timeout: 15000 });
    const paneId = testId(TID_V4_SESSION_PANE, "workspace-main");
    await browser.execute(
      (paneTestId, inputTestId) => {
        const input = document.querySelector(
          `[data-testid="${paneTestId}"] [data-testid="${inputTestId}"]`,
        ) as HTMLElement & { __zcodeLexicalInputE2E?: { setText: (text: string) => void } };
        if (!input?.__zcodeLexicalInputE2E) throw new Error("Composer bridge missing");
        input.__zcodeLexicalInputE2E.setText("E2E_MARKDOWN_DRAFT_KEEP");
      },
      paneId,
      TID_V4_COMPOSER_INPUT,
    );
    for (let i = 0; i < 2; i++) {
      await browser.execute((text) => {
        const root = document.querySelector("[data-markdown-preview]")!;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        while ((node = walker.nextNode())) {
          if (!node.textContent?.includes(text)) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          const selection = window.getSelection()!;
          selection.removeAllRanges();
          selection.addRange(range);
          node.parentElement!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
          return;
        }
        throw new Error("Preview text missing");
      }, marker);
      const action = await $('[data-conversation-selection-action="add-to-task"]');
      await action.waitForDisplayed({ timeout: 5000 });
      const layout = await browser.execute(() => {
        const menu = document.querySelector<HTMLElement>("[data-conversation-selection-tooltip]")!;
        const [add, side] = Array.from(menu.querySelectorAll("button")).map((button) =>
          button.getBoundingClientRect(),
        );
        if (!add || !side) throw new Error("Selection actions missing");
        const rect = menu.getBoundingClientRect();
        return {
          horizontal: Math.abs(add.top - side.top) < 1 && side.left >= add.right,
          adaptive: menu.style.width === "max-content",
          inside: rect.left >= 11 && rect.right <= innerWidth - 11,
        };
      });
      expect(layout).toEqual({ horizontal: true, adaptive: true, inside: true });
      if (i === 0 && process.env.ZCODE_E2E_ARTIFACT_DIR) {
        await browser.saveScreenshot(
          join(process.env.ZCODE_E2E_ARTIFACT_DIR, "markdown-selection-tooltip.png"),
        );
      }
      await action.click();
    }
    const chip = await $(
      `[data-testid="${paneId}"] [data-conversation-selection-reference-count="1"]`,
    );
    await chip.waitForDisplayed();
    expect(await chip.getText()).toContain("selection.md");
    if (process.env.ZCODE_E2E_ARTIFACT_DIR) {
      await browser.saveScreenshot(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR, "markdown-selection-composer.png"),
      );
    }
    const state = await browser.execute(
      (paneTestId, inputTestId) => {
        const pane = document.querySelector(`[data-testid="${paneTestId}"]`)!;
        const input = pane.querySelector(`[data-testid="${inputTestId}"]`) as HTMLElement & {
          __zcodeLexicalInputE2E?: { getText: () => string };
        };
        return {
          session: pane.getAttribute("data-session-id"),
          text: input.__zcodeLexicalInputE2E?.getText(),
        };
      },
      paneId,
      TID_V4_COMPOSER_INPUT,
    );
    expect(state).toEqual({ session: "draft", text: "E2E_MARKDOWN_DRAFT_KEEP" });
    const remove = await $(
      `[data-testid="${paneId}"] button[aria-label="移除对话引用"], [data-testid="${paneId}"] button[aria-label="Remove conversation selection"]`,
    );
    await remove.click();
    await chip.waitForExist({ reverse: true });
    // 移除后重新通过预览添加，验证实际发送与历史消息保留来源。
    await browser.execute(() => {
      const paragraph = document.querySelector("[data-markdown-preview] p")!;
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      paragraph.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    const addAgain = await $('[data-conversation-selection-action="add-to-task"]');
    await addAgain.waitForDisplayed();
    await addAgain.click();
    await sendV4Prompt("E2E_MARKDOWN_SIDE_PARENT Reply with a short acknowledgment.");
    await waitForV4TimelineContaining("E2E_MARKDOWN_SIDE_READY", 30000);
    const evidence = await getUpstreamRequestEvidence({
      lastUserMessageIncludes: ["E2E_MARKDOWN_SIDE_PARENT", "# userselect:"],
      excludes: ["Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
    });
    // 仅搜索文件名会被其他上下文误满足；精确检查实际 userselect 发送合同。
    expect(evidence.length).toBeGreaterThan(0);
    for (const record of evidence) {
      const { messages } = record.requestJson as {
        messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
      };
      const selections = messages
        .filter((message) => message.role === "user")
        .flatMap((message) =>
          typeof message.content === "string"
            ? [message.content]
            : message.content
                .filter((block) => block.type === "text")
                .map((block) => block.text ?? ""),
        )
        .filter((text) => text.includes("E2E_MARKDOWN_SIDE_PARENT"))
        .flatMap((text) =>
          Array.from(
            text.matchAll(/# userselect:\n```userselect\n([^]*?)\n```/g),
            (match) => JSON.parse(match[1]!) as unknown,
          ),
        );
      expect(selections).toEqual([[{ path: filePath, text: marker }]]);
    }
    const historyChip = await $(
      `[data-testid="${paneId}"] [data-conversation-selection-reference-count="1"]`,
    );
    await historyChip.waitForDisplayed();
    expect(await historyChip.getText()).toContain("selection.md");
    // 草稿提升为任务会切换 task-owned 侧栏，重新打开该文件后再选区。
    await $(`[data-testid="${testId(TID_WORKSPACE_FILE_TREE_ROW, filePath)}"]`).click();
    await preview.waitForDisplayed({ timeout: 15000 });
    await browser.execute(
      (paneTestId, inputTestId) => {
        const input = document.querySelector(
          `[data-testid="${paneTestId}"] [data-testid="${inputTestId}"]`,
        ) as HTMLElement & { __zcodeLexicalInputE2E: { setText: (text: string) => void } };
        input.__zcodeLexicalInputE2E.setText("E2E_MARKDOWN_MAIN_KEEP");
      },
      paneId,
      TID_V4_COMPOSER_INPUT,
    );
    // Lexical 提交草稿时会更新原生 Selection；等编辑器提交完成再创建预览选区。
    await browser.executeAsync((done) =>
      requestAnimationFrame(() => requestAnimationFrame(() => done())),
    );
    await browser.execute(() => {
      const paragraph = document.querySelector("[data-markdown-preview] p")!;
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      paragraph.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    const sideAction = await $('[data-conversation-selection-action="ask-in-side-chat"]');
    await sideAction.waitForEnabled({ timeout: 15000 });
    await sideAction.click();
    const sideChip = await $(
      '[data-testid^="v4-session-pane-selection-side-chat:"] [data-conversation-selection-reference-count="1"]',
    );
    await sideChip.waitForDisplayed({ timeout: 30000 });
    expect(await sideChip.getText()).toContain("selection.md");
    const sideState = await browser.execute((inputTestId) => {
      const pane = document.querySelector('[data-testid^="v4-session-pane-selection-side-chat:"]')!;
      const input = pane.querySelector(`[data-testid="${inputTestId}"]`) as HTMLElement & {
        __zcodeLexicalInputE2E?: { getText: () => string };
      };
      const main = document.querySelector('[data-testid="v4-session-pane-workspace-main"]')!;
      const mainInput = main.querySelector(`[data-testid="${inputTestId}"]`) as typeof input;
      return {
        sideText: input.__zcodeLexicalInputE2E?.getText(),
        mainText: mainInput.__zcodeLexicalInputE2E?.getText(),
        distinct: pane.getAttribute("data-session-id") !== main.getAttribute("data-session-id"),
      };
    }, TID_V4_COMPOSER_INPUT);
    expect(sideState).toEqual({ sideText: "", mainText: "E2E_MARKDOWN_MAIN_KEEP", distinct: true });
    if (process.env.ZCODE_E2E_ARTIFACT_DIR)
      await browser.saveScreenshot(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR, "markdown-side-conversation.png"),
      );
  });
});
