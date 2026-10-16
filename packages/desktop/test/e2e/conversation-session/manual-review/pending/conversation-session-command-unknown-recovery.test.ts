import { clearAppData } from "../../../helpers/desktop-app.js";
import {
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "../../../helpers/v4-conversation.js";

const CASE_TIMEOUT_MS = 120_000;
const PENDING_COMMAND_STORAGE_KEY = "zcode-v4-pending-commands:v1";
const PROMPT_MARKER = "E2E_COMMAND_UNKNOWN_RECOVERY";
const REPLY_MARKER = "COMMAND_UNKNOWN_RECOVERY_OK";
const UNKNOWN_TEXT = "E2E_UNKNOWN_COMMAND_MUST_NOT_REPLAY";

describe("PV4-25U：unknown command recovery 静默清账", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("renderer reload 后真实 commands/query=unknown 不显示恢复提示也不重放", async function () {
    this.timeout(CASE_TIMEOUT_MS);

    await prepareV4ConversationE2E();
    await sendV4Prompt(`${PROMPT_MARKER}: Reply with exactly "${REPLY_MARKER}" and no other text.`);
    await waitForV4TimelineContaining(REPLY_MARKER, 60_000);
    const terminal = await waitForV4Pane(
      (snapshot) =>
        !snapshot.canStop && Boolean(snapshot.sessionId && snapshot.sessionId !== "draft"),
      "PV4-25U 前置 session 没有完成",
      60_000,
    );
    const sessionId = requireSessionId(terminal.sessionId);
    const commandId = `e2e-unknown-${Date.now()}`;

    await seedPendingSendText(sessionId, commandId, UNKNOWN_TEXT);
    expect(await readPendingCommandIds()).toContain(commandId);

    // Bug 根因：旧实现把 CLI 没有任何持久事实的 unknown 当成可操作错误，renderer
    // reload 后会长期显示“重新发送”。unknown 只说明无权威结论，必须静默清除本地线索。
    await browser.refresh();
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === sessionId && !snapshot.canStop,
      "PV4-25U renderer reload 后没有恢复原 session",
      60_000,
    );
    await waitForPendingCommandRemoved(commandId);

    expect(await hasPendingRecoveryBanner()).toBe(false);
    expect((await getV4PaneSnapshot()).timelineText).not.toContain(UNKNOWN_TEXT);
  });
});

function requireSessionId(value: string | null): string {
  if (!value || value === "draft") {
    throw new Error(`PV4-25U 缺少 sessionId: ${String(value)}`);
  }
  return value;
}

async function seedPendingSendText(sessionId: string, commandId: string, text: string) {
  await browser.execute(
    (storageKey, currentSessionId, currentCommandId, currentText, now) => {
      window.localStorage.setItem(
        storageKey,
        JSON.stringify([
          {
            commandId: currentCommandId,
            clientId: "e2e-command-recovery",
            sessionId: currentSessionId,
            issuedAt: now,
            expiresAt: now + 60_000,
            replay: {
              kind: "input",
              type: "sendText",
              payload: { text: currentText, attachments: [] },
            },
          },
        ]),
      );
    },
    PENDING_COMMAND_STORAGE_KEY,
    sessionId,
    commandId,
    text,
    Date.now(),
  );
}

function readPendingCommandIds(): Promise<string[]> {
  return browser.execute((storageKey) => {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return [];
    try {
      const entries = JSON.parse(raw) as Array<{ commandId?: unknown }>;
      return entries.flatMap((entry) =>
        typeof entry.commandId === "string" ? [entry.commandId] : [],
      );
    } catch {
      return ["<invalid-json>"];
    }
  }, PENDING_COMMAND_STORAGE_KEY);
}

async function waitForPendingCommandRemoved(commandId: string) {
  await browser.waitUntil(async () => !(await readPendingCommandIds()).includes(commandId), {
    timeout: 30_000,
    timeoutMsg: `PV4-25U unknown command ${commandId} 没有从 renderer ledger 清除`,
  });
}

function hasPendingRecoveryBanner(): Promise<boolean> {
  return browser.execute(() => {
    const text = document.body.innerText;
    return (
      text.includes("CLI 重启前已提交的输入没有进入对话") ||
      text.includes("An input submitted before the CLI restarted did not reach the conversation")
    );
  });
}
