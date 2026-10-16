import {
  TID_CHAT_COMPACT_MARKER,
  TID_CHAT_INPUT,
  TID_CHAT_MESSAGES,
} from "@zcode/shared";
import { UPSTREAM_MODEL } from "../../../helpers/upstream-provider.js";
import {
  assertUpstreamRequestCapture,
  waitForUpstreamNetworkCapture,
} from "../../../helpers/upstream-capture.js";
import type { E2ENetworkCaptureRecord } from "../../../helpers/network-capture-proxy.js";
import AppPage from "../../../pages/app.page.js";
import { clearAppData } from "../../../helpers/desktop-app.js";
import {
  buildReadonlyToolPrompt,
  prepareConversationE2E,
} from "../../../helpers/conversation-session.js";

const INITIAL_REPLY_TOKEN = "upstream-e2e-ok";
const INITIAL_PROMPT = buildReadonlyToolPrompt("E2E_COMPACT_INITIAL");
const COMPACT_COMMAND = "/compact";
const COMPACT_REQUEST_SENTINEL = "CRITICAL: Respond with TEXT ONLY";

interface CompactMarkerSnapshot {
  inputId: string | null;
  operationId: string | null;
  status: string | null;
  testId: string | null;
  text: string;
  trigger: string | null;
}

describe("会话区 Compact E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("手动 /compact 成功时应展示 completed 横条并发起非流式 compact 请求", async function () {
    this.timeout(150000);

    await prepareConversationE2E();

    await typeChatPrompt(INITIAL_PROMPT);
    await clickChatSend();
    await waitForUpstreamNetworkCapture(INITIAL_REPLY_TOKEN);
    await waitForAssistantReplyToken();

    await typeChatPrompt(COMPACT_COMMAND);
    await clickChatSend();
    await waitForComposerText("", "/compact 发送后输入框没有清空");

    const startedMarker = await waitForCompactMarkerStatus("started");
    expect(startedMarker.trigger).toBe("manual");
    expect(startedMarker.inputId).toBeTruthy();

    const compactRecord = await waitForUpstreamNetworkCapture(COMPACT_REQUEST_SENTINEL);
    assertUpstreamRequestCapture(compactRecord, {
      expectedText: COMPACT_REQUEST_SENTINEL,
      model: UPSTREAM_MODEL,
    });
    assertNonStreamingCompactRequest(compactRecord);
    assertCaptureIncludesText(compactRecord.requestJson, INITIAL_REPLY_TOKEN);

    const completedMarker = await waitForCompactMarkerStatus(
      "completed",
      startedMarker.inputId,
    );
    expect(completedMarker.trigger).toBe("manual");
    expect(completedMarker.operationId).toBeTruthy();
    await assertVisibleUserMessagesNotContaining(COMPACT_COMMAND);
  });
});

async function typeChatPrompt(prompt: string) {
  await AppPage.chatInput.waitForDisplayed({ timeout: 15000 });
  await AppPage.chatInput.click();
  const result = (await browser.executeAsync(
    (inputTestId, text, done) => {
      const input = document.querySelector<HTMLElement>(
        `[data-testid="${inputTestId}"]`,
      );
      if (!input) {
        done({ actual: "", inserted: false, ok: false, reason: "input-missing" });
        return;
      }

      input.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(input);
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.execCommand("delete");
      const inserted = document.execCommand("insertText", false, text);

      requestAnimationFrame(() => {
        const actual = (input.innerText || input.textContent || "")
          .replace(/\u00a0/g, " ")
          .trim();
        done({
          actual,
          inserted,
          ok: actual === text.trim(),
        });
      });
    },
    TID_CHAT_INPUT,
    prompt,
  )) as { actual: string; inserted: boolean; ok: boolean; reason?: string };

  if (!result.ok) {
    throw new Error(
      `聊天输入框没有写入完整 prompt: ${JSON.stringify(result)}`,
    );
  }
}

async function clickChatSend() {
  await AppPage.chatSendButton.waitForClickable({ timeout: 30000 });
  await AppPage.chatSendButton.click();
}

async function waitForComposerText(expected: string, timeoutMsg: string) {
  await browser.waitUntil(async () => (await getComposerText()) === expected, {
    timeout: 10000,
    timeoutMsg,
  });
}

async function getComposerText() {
  return browser.execute((inputTestId) => {
    const input = document.querySelector<HTMLElement>(
      `[data-testid="${inputTestId}"]`,
    );
    return (input?.innerText || input?.textContent || "")
      .replace(/\u00a0/g, " ")
      .trim();
  }, TID_CHAT_INPUT);
}

async function waitForAssistantReplyToken() {
  await browser.waitUntil(
    async () => {
      const messages = await AppPage.assistantMessages;
      for (const message of messages) {
        const text = await message.getText();
        if (text.includes(INITIAL_REPLY_TOKEN)) {
          return true;
        }
      }
      return false;
    },
    {
      timeout: 90000,
      timeoutMsg: "没有收到 compact 前置主会话回复",
    },
  );
}

async function waitForCompactMarkerStatus(
  status: "started" | "completed",
  inputId?: string | null,
): Promise<CompactMarkerSnapshot> {
  let latestMarkers: CompactMarkerSnapshot[] = [];
  await browser.waitUntil(
    async () => {
      latestMarkers = await getCompactMarkers();
      return latestMarkers.some(
        (marker) =>
          marker.status === status &&
          marker.trigger === "manual" &&
          (!inputId || marker.inputId === inputId),
      );
    },
    {
      timeout: status === "started" ? 20000 : 90000,
      timeoutMsg: `没有等到 compact marker status=${status}，latest=${JSON.stringify(
        latestMarkers,
        null,
        2,
      )}`,
    },
  );

  const marker = latestMarkers.find(
    (candidate) =>
      candidate.status === status &&
      candidate.trigger === "manual" &&
      (!inputId || candidate.inputId === inputId),
  );
  if (!marker) {
    throw new Error(`compact marker status=${status} 在等待完成后仍不存在`);
  }
  return marker;
}

function getCompactMarkers() {
  return browser.execute((compactMarkerPrefix) => {
    return Array.from(
      document.querySelectorAll<HTMLElement>(
        `[data-testid^="${compactMarkerPrefix}-"]`,
      ),
    ).map((element) => ({
      inputId: element.getAttribute("data-input-id"),
      operationId: element.getAttribute("data-operation-id"),
      status: element.getAttribute("data-status"),
      testId: element.getAttribute("data-testid"),
      text: element.innerText.trim(),
      trigger: element.getAttribute("data-trigger"),
    }));
  }, TID_CHAT_COMPACT_MARKER);
}

function assertNonStreamingCompactRequest(record: E2ENetworkCaptureRecord) {
  const request = asRecord(record.requestJson);
  expect(request.stream).not.toBe(true);
  expect(record.responseHeaders["content-type"]).not.toContain("text/event-stream");
}

function assertCaptureIncludesText(value: unknown, expected: string) {
  if (captureContainsText(value, expected)) {
    return;
  }
  throw new Error(`抓包请求没有包含预期文本: ${expected}`);
}

function captureContainsText(value: unknown, expected: string): boolean {
  if (typeof value === "string") {
    return value.includes(expected);
  }
  if (Array.isArray(value)) {
    return value.some((item) => captureContainsText(item, expected));
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  return Object.values(value).some((child) => captureContainsText(child, expected));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function assertVisibleUserMessagesNotContaining(text: string) {
  expect(await getVisibleUserMessagesText()).not.toContain(text);
}

function getVisibleUserMessagesText() {
  return browser.execute((messagesTestId) => {
    const root = document.querySelector<HTMLElement>(
      `[data-testid="${messagesTestId}"]`,
    );
    return Array.from(root?.querySelectorAll<HTMLElement>(".is-user") ?? [])
      .map((element) => element.innerText)
      .join("\n");
  }, TID_CHAT_MESSAGES);
}
