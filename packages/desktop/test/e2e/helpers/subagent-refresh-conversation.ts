import {
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
  waitForV4UserMessageContaining,
  getV4Messages,
} from "./v4-conversation.js";
import { TID_CHAT_ERROR_BANNER } from "@zcode/shared";
import { readSubagentCapture } from "./subagent-refresh-capture.js";

export async function assertSubagentTurnFailed(marker: string, error: string) {
  await browser.waitUntil(
    async () =>
      (
        await browser.execute(
          (id) =>
            Array.from(document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`))
              .map((element) => element.textContent ?? "")
              .join("\n"),
          TID_CHAT_ERROR_BANNER,
        )
      ).includes(error),
    { timeout: 15000, timeoutMsg: `父轮未显示配置读取错误：${error}` },
  );
  await waitForSubagentIdle(15000);
  await waitForV4UserMessageContaining(marker);
  expect(
    (await getV4Messages("user")).filter((message) => message.text.includes(marker)),
  ).toHaveLength(1);
  expect(
    (await readSubagentCapture()).filter((record) =>
      JSON.stringify(record.requestJson).includes(marker),
    ),
  ).toHaveLength(0);
}

/** Settings 选择器使用英文文案；只调用仓库已有的测试 UI 入口。 */
export async function useEnglishSubagentSettings() {
  await browser.execute(() => {
    const actions = (
      window as typeof window & {
        __testActions?: { setLocale?: (locale: string) => void };
      }
    ).__testActions;
    if (!actions?.setLocale) throw new Error("Missing locale action");
    actions.setLocale("en-US");
  });
}
export async function waitForSubagentIdle(timeout: number) {
  await waitForV4ConversationState(
    (state) => state.state === "idle" && state.queueCount === 0,
    "父轮未结束",
    timeout,
  );
}
export async function finishSubagentTurn(token: string, timeout: number) {
  await waitForV4AssistantMessageContaining(token, timeout);
  await waitForSubagentIdle(timeout);
}
