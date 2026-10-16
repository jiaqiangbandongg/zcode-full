import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { TID_V4_COMPOSER_INPUT } from "@zcode/shared";
import { waitForDefaultWorkspaceReady } from "./desktop-app.js";

const LABEL = "selection-demo.ts";
const MARKDOWN = `[${LABEL}](src/${LABEL})`;

export function registerMentionSelectionCases() {
  for (const position of ["text", "leading", "middle", "trailing", "only", "adjacent"]) {
    it(`selects and replaces the complete draft with ${position} mentions`, async () => {
      await waitForDefaultWorkspaceReady(30000);
      const expected = await seedMentionSelection(position);
      const modifier = process.platform === "darwin" ? "\uE03D" : "\uE009";
      await browser.keys([modifier, "a", "\uE000"]);
      await browser.waitUntil(
        async () => {
          const selection = await readMentionSelection();
          return selection.selected === expected && !selection.collapsed;
        },
        { timeout: 5000, timeoutMsg: `${position}: native selection did not cover the draft` },
      );
      if (position === "middle") {
        const directory = join(process.cwd(), ".e2e-artifacts", "mention-selection");
        await mkdir(directory, { recursive: true });
        await browser.saveScreenshot(join(directory, "native-select-all.png"));
      }
      await browser.keys("E2E_REPLACEMENT");
      await browser.waitUntil(
        async () => {
          const selection = await readMentionSelection();
          return selection.markdown === "E2E_REPLACEMENT" && selection.mentions === 0;
        },
        { timeout: 5000, timeoutMsg: `${position}: replacement left old content behind` },
      );
    });
  }

  it("copies and cuts canonical mentions through the native clipboard", async () => {
    await waitForDefaultWorkspaceReady(30000);
    const previous = await browser.electron.execute((electron) => electron.clipboard.readText());
    try {
      await seedMentionSelection("middle");
      const modifier = process.platform === "darwin" ? "\uE03D" : "\uE009";
      await browser.keys([modifier, "a", "\uE000"]);
      await browser.keys([modifier, "c", "\uE000"]);
      await browser.waitUntil(
        async () =>
          (await browser.electron.execute((electron) => electron.clipboard.readText())) ===
          `hello ${MARKDOWN} world`,
      );
      expect((await readMentionSelection()).markdown).toBe(`hello ${MARKDOWN} world`);
      await browser.keys([modifier, "x", "\uE000"]);
      await browser.waitUntil(async () => (await readMentionSelection()).markdown === "");
      expect(await browser.electron.execute((electron) => electron.clipboard.readText())).toBe(
        `hello ${MARKDOWN} world`,
      );
    } finally {
      await browser.electron.execute(
        (electron, text) => electron.clipboard.writeText(text),
        previous,
      );
    }
  });

  it("deletes and restores selected mentions through native undo", async () => {
    await waitForDefaultWorkspaceReady(30000);
    await seedMentionSelection("only");
    const modifier = process.platform === "darwin" ? "\uE03D" : "\uE009";
    await browser.keys([modifier, "a", "\uE000"]);
    await browser.keys("Backspace");
    await browser.waitUntil(async () => (await readMentionSelection()).markdown === "");
    await browser.keys([modifier, "z", "\uE000"]);
    await browser.waitUntil(
      async () => {
        const selection = await readMentionSelection();
        return selection.markdown === MARKDOWN && selection.mentions === 1;
      },
      { timeout: 5000, timeoutMsg: "undo did not restore the canonical mention" },
    );
  });
}

async function seedMentionSelection(position: string) {
  const expected = await browser.execute(
    (testId, label, markdown, placement) => {
      const input = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
      const bridge = (
        input as HTMLElement & {
          __zcodeLexicalInputE2E?: { setEditorStateJson: (s: string) => void; focus: () => void };
        }
      )?.__zcodeLexicalInputE2E;
      if (!input || !bridge) throw new Error("Lexical bridge unavailable");
      const text = (value: string) => ({
        type: "text",
        version: 1,
        text: value,
        format: 0,
        detail: 0,
        mode: "normal",
        style: "",
      });
      const token = {
        ...text(label),
        type: "prompt-mention",
        mode: "token",
        mentionId: "E2E_SELECTION_FILE",
        category: "files",
        value: `src/${label}`,
        markdown,
        data: { path: `src/${label}` },
      };
      const children =
        placement === "text"
          ? [text("hello world")]
          : placement === "leading"
            ? [token, text(" world")]
            : placement === "middle"
              ? [text("hello "), token, text(" world")]
              : placement === "trailing"
                ? [text("hello "), token]
                : placement === "adjacent"
                  ? [token, { ...token, mentionId: "E2E_SELECTION_FILE_2" }]
                  : [token];
      bridge.setEditorStateJson(
        JSON.stringify({
          root: {
            type: "root",
            version: 1,
            format: "",
            indent: 0,
            direction: null,
            children: [
              { type: "paragraph", version: 1, format: "", indent: 0, direction: null, children },
            ],
          },
        }),
      );
      bridge.focus();
      return children.map((child) => child.text).join("");
    },
    TID_V4_COMPOSER_INPUT,
    LABEL,
    MARKDOWN,
    position,
  );
  // 首次挂载的 focus 请求异步提交；真实点击后确认焦点，再发送全选键，避免选中整页。
  await browser.$(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`).click();
  await browser.waitUntil(() =>
    browser.execute((testId) => {
      const input = document.querySelector(`[data-testid="${testId}"]`);
      return Boolean(
        input && (document.activeElement === input || input.contains(document.activeElement)),
      );
    }, TID_V4_COMPOSER_INPUT),
  );
  return expected;
}

async function readMentionSelection() {
  return browser.execute((testId) => {
    const input = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    const bridge = (input as HTMLElement & { __zcodeLexicalInputE2E?: { getText: () => string } })
      ?.__zcodeLexicalInputE2E;
    return {
      selected: window.getSelection()?.toString(),
      collapsed: window.getSelection()?.isCollapsed,
      markdown: bridge?.getText(),
      mentions: input?.querySelectorAll("[data-mention-id]").length,
    };
  }, TID_V4_COMPOSER_INPUT);
}
