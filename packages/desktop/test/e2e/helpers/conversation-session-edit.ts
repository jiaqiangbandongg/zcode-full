import {
  TID_CHAT_ASSISTANT_MESSAGE,
  TID_CHAT_MESSAGE_EDIT_BUTTON,
  TID_CHAT_MESSAGE_EDIT_INPUT,
  TID_CHAT_MESSAGE_EDIT_SUBMIT,
  TID_CHAT_USER_MESSAGE,
  testId,
} from "@zcode/shared";
import { clickTestIdByDom } from "./desktop-app.js";

export interface EditButtonSnapshot {
  ariaDisabled: boolean;
  disabled: boolean;
  exists: boolean;
  messageId: string;
  testId: string;
  text: string;
}

type LexicalInputE2EBridge = {
  focus: () => void;
  getText: () => string;
  setText: (text: string) => void;
};

type LexicalInputE2EElement = HTMLElement & {
  __zcodeLexicalInputE2E?: LexicalInputE2EBridge;
};

export async function waitForEditButtonForUserContaining(
  text: string,
  options: { enabled?: boolean } = {},
): Promise<EditButtonSnapshot> {
  const expectEnabled = options.enabled ?? true;
  let latest: EditButtonSnapshot | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await getEditButtonForUserContaining(text);
        if (!latest?.exists) {
          return false;
        }
        if (!expectEnabled) {
          return true;
        }
        return !latest.disabled && !latest.ariaDisabled;
      },
      {
        timeout: 30000,
        timeoutMsg: `user 消息没有出现可用 edit 按钮: ${text}`,
      }
    );
  } catch (error) {
    latest = await getEditButtonForUserContaining(text);
    throw new Error(
      `user 消息没有出现可用 edit 按钮: ${text}; latest=${JSON.stringify(latest)}`,
      { cause: error },
    );
  }
  if (!latest) {
    throw new Error(`user edit 按钮在等待后仍不存在: ${text}`);
  }
  return latest;
}

async function waitForStableEditButtonForUserContaining(
  text: string,
  options: { enabled?: boolean } = {},
): Promise<EditButtonSnapshot> {
  const expectEnabled = options.enabled ?? true;
  const startedAt = Date.now();
  let latest: EditButtonSnapshot | null = null;
  while (Date.now() - startedAt < 30000) {
    const first = await getEditButtonForUserContaining(text);
    if (
      first?.exists &&
      (!expectEnabled || (!first.disabled && !first.ariaDisabled))
    ) {
      await browser.pause(250);
      const second = await getEditButtonForUserContaining(text);
      if (
        second?.exists &&
        second.messageId === first.messageId &&
        second.testId === first.testId &&
        (!expectEnabled || (!second.disabled && !second.ariaDisabled))
      ) {
        return second;
      }
      latest = second;
    } else {
      latest = first;
    }
    await browser.pause(100);
  }
  throw new Error(
    `user 消息 edit 按钮没有稳定下来: ${text}; latest=${JSON.stringify(latest)}`,
  );
}

export async function clickEditButtonForUserContaining(text: string) {
  const button = await waitForStableEditButtonForUserContaining(text, {
    enabled: true,
  });
  await clickTestIdByDom(button.testId, {
    timeout: 15000,
    timeoutMsg: `user edit 按钮不可点击: ${text}`,
  });
  return button;
}

export async function editUserMessageContaining(
  currentText: string,
  nextText: string,
) {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const button = await clickEditButtonForUserContaining(currentText);
    try {
      await setMessageEditInputText(button.messageId, nextText);
      await clickTestIdByDom(
        testId(TID_CHAT_MESSAGE_EDIT_SUBMIT, button.messageId),
        {
          timeout: 15000,
          timeoutMsg: `user edit 提交按钮不可点击: ${button.messageId}`,
        },
      );
      return button;
    } catch (error) {
      lastError = error;
      // 修复原因：完成态最后一轮可能刚从 optimistic renderer id 切到快照 id。
      // 这时 edit 输入框会随着旧消息节点卸载；重新定位用户看见的同一条消息再编辑。
      if (!(error instanceof Error) || !isRetryableEditInputError(error)) {
        throw error;
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`user edit 重试失败: ${currentText}`);
}

function isRetryableEditInputError(error: Error) {
  return (
    error.message.includes("input-missing") ||
    // Bugfix: Windows Electron 下 edit button 点击后，旧 optimistic message id 对应的
    // 输入框可能已挂载但还未显示；重新定位用户可见消息后再点一次更稳定。
    error.message.includes("edit 输入框没有显示")
  );
}

export function getEditButtonForUserContaining(
  text: string,
): Promise<EditButtonSnapshot | null> {
  return getEditButtonForMessageContaining(TID_CHAT_USER_MESSAGE, text);
}

export function getEditButtonForAssistantContaining(
  text: string,
): Promise<EditButtonSnapshot | null> {
  return getEditButtonForMessageContaining(TID_CHAT_ASSISTANT_MESSAGE, text);
}

export async function setMessageEditInputText(messageId: string, text: string) {
  const inputTestId = testId(TID_CHAT_MESSAGE_EDIT_INPUT, messageId);
  await setLexicalInputTextByTestId(inputTestId, text);
}

async function setLexicalInputTextByTestId(testIdValue: string, text: string) {
  await browser.waitUntil(
    async () =>
      browser.execute((inputTestId) => {
        return Boolean(document.querySelector(`[data-testid="${inputTestId}"]`));
      }, testIdValue),
    {
      timeout: 15000,
      timeoutMsg: `edit 输入框没有出现: ${testIdValue}`,
    },
  );
  const inputElement = await $(`[data-testid="${testIdValue}"]`);
  await inputElement.waitForDisplayed({
    timeout: 15000,
    timeoutMsg: `edit 输入框没有显示: ${testIdValue}`,
  });

  await waitForEditInputInitializers(testIdValue);

  let actual = "";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const result = await replaceContentEditableTextByDom(testIdValue, text);
    actual = result.actual;
    if (result.ok) {
      return;
    }
    await waitForEditInputInitializers(testIdValue);
  }

  throw new Error(
    `edit 输入框没有写入完整 prompt: expected=${text}, actual=${actual}`,
  );
}

function getEditInputDiagnostics(testIdValue: string) {
  return browser.execute((inputTestId) => {
    const input = document.querySelector<HTMLElement>(
      `[data-testid="${inputTestId}"]`,
    );
    const nearby = Array.from(
      document.querySelectorAll<HTMLElement>(
        `[data-testid^="chat-message-edit-input-"]`,
      ),
    ).map((element) => ({
      bridgeAttr: element.getAttribute("data-e2e-lexical-bridge"),
      contentEditable: element.getAttribute("contenteditable"),
      testId: element.getAttribute("data-testid"),
      text: (element.innerText ?? element.textContent ?? "").slice(0, 80),
    }));
    return {
      bridgeAttr: input?.getAttribute("data-e2e-lexical-bridge") ?? null,
      bridgeProperty: Boolean(
        (input as LexicalInputE2EElement | null)?.__zcodeLexicalInputE2E,
      ),
      contentEditable: input?.getAttribute("contenteditable") ?? null,
      exists: Boolean(input),
      nearby,
      tagName: input?.tagName ?? null,
      text: (input?.innerText ?? input?.textContent ?? "").slice(0, 120),
    };
  }, testIdValue);
}

async function waitForEditInputInitializers(testIdValue: string) {
  await browser.executeAsync((inputTestId, done) => {
    const input = document.querySelector<LexicalInputE2EElement>(
      `[data-testid="${inputTestId}"]`,
    );
    input?.__zcodeLexicalInputE2E?.focus();
    // 修复原因：UserMessage 和 ChatPromptEditor 都会在 RAF 回填 initialValue。
    // 等两帧后再模拟用户输入，避免刚写入的新文本被初始化回填覆盖。
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        done(null);
      });
    });
  }, testIdValue);
}

async function replaceContentEditableTextByDom(testIdValue: string, text: string) {
  const result = (await browser.executeAsync(
    (inputTestId, nextText, done) => {
      const input = document.querySelector<LexicalInputE2EElement>(
        `[data-testid="${inputTestId}"]`,
      );
      if (!input) {
        done({ actual: "", ok: false, reason: "input-missing" });
        return;
      }

      const readActualText = () => {
        const latestInput = document.querySelector<LexicalInputE2EElement>(
          `[data-testid="${inputTestId}"]`,
        );
        const latestBridge = latestInput?.__zcodeLexicalInputE2E;
        return (
          latestBridge?.getText() ??
          latestInput?.innerText ??
          latestInput?.textContent ??
          ""
        )
          .replace(/\u00a0/g, " ")
          .trim();
      };

      const bridge = input.__zcodeLexicalInputE2E;
      if (bridge) {
        bridge.focus();
        bridge.setText("");
        // 修复原因：Lexical 对 contenteditable 的 selection/delete 接管较强，
        // DOM execCommand 只能把新文本插到旧内容前面。测试 bridge 模拟的是
        // 编辑器自身更新路径，先清空再写入才能得到用户真实提交的 prompt。
        requestAnimationFrame(() => {
          const latestInput = document.querySelector<LexicalInputE2EElement>(
            `[data-testid="${inputTestId}"]`,
          );
          const latestBridge = latestInput?.__zcodeLexicalInputE2E;
          if (!latestBridge) {
            done({
              actual: "",
              ok: false,
              reason: "bridge-missing-after-clear",
            });
            return;
          }
          latestBridge.setText(nextText);
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              const actual = readActualText();
              done({
                actual,
                inserted: true,
                ok: actual === nextText.trim(),
                via: "bridge",
              });
            });
          });
        });
        return;
      }

      input.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(input);
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.execCommand("delete");

      let inserted = true;
      const lines = nextText.split("\n");
      for (const [lineIndex, line] of lines.entries()) {
        inserted = document.execCommand("insertText", false, line) && inserted;
        if (lineIndex < lines.length - 1) {
          inserted = document.execCommand("insertLineBreak") && inserted;
        }
      }

      // 修复原因：edit 输入框打开后会经历 initialValue 回填和 Lexical state 同步。
      // 这里用 contenteditable 的真实编辑命令驱动，避免直接改 React state 绕过 UI 行为。
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const actual = readActualText();
          done({ actual, inserted, ok: actual === nextText.trim(), via: "dom" });
        });
      });
    },
    testIdValue,
    text,
  )) as {
    actual: string;
    inserted?: boolean;
    ok: boolean;
    reason?: string;
    via?: "bridge" | "dom";
  };
  if (!result.ok && result.reason === "input-missing") {
    const diagnostics = await getEditInputDiagnostics(testIdValue);
    return {
      ...result,
      actual: `${result.actual}; reason=${result.reason}; diagnostics=${JSON.stringify(diagnostics)}`,
    };
  }
  return result;
}

function getEditButtonForMessageContaining(
  messagePrefix: string,
  text: string,
): Promise<EditButtonSnapshot | null> {
  return browser.execute(
    (targetMessagePrefix, editButtonPrefix, expectedText) => {
      const messages = Array.from(
        document.querySelectorAll<HTMLElement>(
          `[data-testid^="${targetMessagePrefix}-"]`,
        ),
      );
      const message = messages.find((element) =>
        element.innerText.replace(/\u00a0/g, " ").includes(expectedText),
      );
      const messageId = message?.getAttribute("data-message-id");
      if (!message || !messageId) {
        return null;
      }
      const button = Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          `[data-testid^="${editButtonPrefix}-"]`,
        ),
      ).find((candidate) => candidate.getAttribute("data-message-id") === messageId);
      const resolvedTestId =
        button?.getAttribute("data-testid") ?? `${editButtonPrefix}-${messageId}`;
      return {
        ariaDisabled: button?.getAttribute("aria-disabled") === "true",
        disabled: button?.disabled ?? false,
        exists: Boolean(button),
        messageId,
        testId: resolvedTestId,
        text: button?.innerText.trim() ?? "",
      };
    },
    messagePrefix,
    TID_CHAT_MESSAGE_EDIT_BUTTON,
    text,
  );
}
