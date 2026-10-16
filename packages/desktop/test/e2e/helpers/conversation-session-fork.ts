import {
  TID_CHAT_ASSISTANT_MESSAGE,
  TID_CHAT_MESSAGE_FORK_BUTTON,
  TID_CHAT_USER_MESSAGE,
} from "@zcode/shared";
import { clickTestIdByDom } from "./desktop-app.js";

export interface ForkButtonSnapshot {
  ariaDisabled: boolean;
  disabled: boolean;
  exists: boolean;
  messageId: string;
  testId: string;
  text: string;
}

export async function waitForForkButtonForAssistantContaining(
  text: string,
  options: { enabled?: boolean } = {},
): Promise<ForkButtonSnapshot> {
  const expectEnabled = options.enabled ?? true;
  let latest: ForkButtonSnapshot | null = null;
  await browser.waitUntil(
    async () => {
      latest = await getForkButtonForAssistantContaining(text);
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
      timeoutMsg: `assistant 消息没有出现可用 fork 按钮: ${text}; latest=${JSON.stringify(
        latest,
      )}`,
    },
  );
  if (!latest) {
    throw new Error(`assistant fork 按钮在等待后仍不存在: ${text}`);
  }
  return latest;
}

export async function clickForkButtonForAssistantContaining(text: string) {
  const button = await waitForForkButtonForAssistantContaining(text, {
    enabled: true,
  });
  await clickTestIdByDom(button.testId, {
    timeout: 15000,
    timeoutMsg: `assistant fork 按钮不可点击: ${text}`,
  });
  return button;
}

export function getForkButtonForAssistantContaining(
  text: string,
): Promise<ForkButtonSnapshot | null> {
  return getForkButtonForMessageContaining(TID_CHAT_ASSISTANT_MESSAGE, text);
}

export function getForkButtonForUserContaining(
  text: string,
): Promise<ForkButtonSnapshot | null> {
  return getForkButtonForMessageContaining(TID_CHAT_USER_MESSAGE, text);
}

function getForkButtonForMessageContaining(
  messagePrefix: string,
  text: string,
): Promise<ForkButtonSnapshot | null> {
  return browser.execute(
    (messageTestIdPrefix, forkButtonPrefix, expectedText) => {
      const messages = Array.from(
        document.querySelectorAll<HTMLElement>(
          `[data-testid^="${messageTestIdPrefix}-"]`,
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
          `[data-testid^="${forkButtonPrefix}-"]`,
        ),
      ).find((candidate) => candidate.getAttribute("data-message-id") === messageId);
      const testId = button?.getAttribute("data-testid") ?? `${forkButtonPrefix}-${messageId}`;
      return {
        ariaDisabled: button?.getAttribute("aria-disabled") === "true",
        disabled: button?.disabled ?? false,
        exists: Boolean(button),
        messageId,
        testId,
        text: button?.innerText.trim() ?? "",
      };
    },
    messagePrefix,
    TID_CHAT_MESSAGE_FORK_BUTTON,
    text,
  );
}
