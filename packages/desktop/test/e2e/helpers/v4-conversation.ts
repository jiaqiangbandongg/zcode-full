/* eslint-disable max-lines -- v4 conversation e2e helper 集中承载 pane/composer/queue/分屏等全部定位与断言原语，拆分会让 spec 的导入面漂移。 */
// v4 竖切（protocol-v4）conversation e2e helper。
// 与旧 conversation-session.ts 的区别：所有定位走 TID_V4_* 常量（testid contract v2，
// 带 paneId 维度），状态断言读 v4 pane 的 data-* 投影属性，不再依赖旧 ChatView DOM。
// 旧 helper 的登录/工作区/provider 部分继续复用（desktop-app.ts / upstream-provider.ts）。
import {
  TID_CHAT_MODE_SELECT_ITEM,
  TID_CHAT_MODE_SELECT_TRIGGER,
  TID_CHAT_SUMMARY_PANEL,
  TID_CHAT_MODEL_SELECT_GROUP,
  TID_CHAT_MODEL_SELECT_ITEM,
  TID_CHAT_MODEL_SELECT_TRIGGER,
  TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM,
  TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER,
  TID_PROMPT_SUGGESTION_OPTION,
  TID_PROMPT_SUGGESTION_PANEL,
  TID_LOGIN_API_KEY_CONTINUE_BUTTON,
  TID_LOGIN_API_KEY_INPUT,
  TID_LOGIN_USE_API_KEY_BUTTON,
  TID_TASK_ITEM,
  TID_TASK_NEW_BUTTON,
  TID_V4_AUTODRAIN_TOGGLE,
  TID_V4_ATTACHMENT,
  TID_V4_BACKGROUND_WORK_ITEM,
  TID_V4_COMPOSER,
  TID_V4_COMPOSER_BACKGROUND_WORK_TRIGGER,
  TID_V4_COMPOSER_CLEAR_QUEUE_SEND,
  TID_V4_COMPOSER_INPUT,
  TID_V4_COMPOSER_KEEP_QUEUE_SEND,
  TID_V4_COMPOSER_SEND,
  TID_V4_DELETE_SESSION,
  TID_V4_EDIT,
  TID_V4_EDIT_INPUT,
  TID_V4_EDIT_REWIND_WORKSPACE,
  TID_V4_EDIT_SUBMIT,
  TID_V4_EDIT_WORKSPACE_CONFLICT_CONVERSATION_ONLY,
  TID_V4_EDIT_WORKSPACE_CONFLICT_DIALOG,
  TID_V4_FOLLOWUP_TOGGLE,
  TID_V4_MODEL_CONFIG,
  TID_V4_PAUSED_QUEUE_SEND_DIALOG,
  TID_V4_PANE_SHELL,
  TID_V4_QUEUE,
  TID_V4_QUEUE_ITEM,
  TID_V4_QUEUE_PAUSED_BANNER,
  TID_V4_QUEUE_RESUME,
  TID_V4_RENAME_INPUT,
  TID_V4_RENAME_SUBMIT,
  TID_V4_ROW,
  TID_V4_ROW_ATTACHMENTS,
  TID_V4_SESSION_PANE,
  TID_V4_SESSION_TITLE,
  TID_V4_SPLIT_CLOSE,
  TID_V4_SPLIT_DOWN,
  TID_V4_SPLIT_DIVIDER,
  TID_V4_SPLIT_OPEN,
  TID_V4_TASK_OPEN_IN_SPLIT,
  TID_V4_STOP,
  TID_V4_TIMELINE,
  TID_V4_TIMELINE_BOTTOM,
  TID_V4_TURN_NAVIGATOR,
  TID_V4_TURN_NAVIGATOR_ITEM,
  TID_V4_TURN_NAVIGATOR_TOOLTIP,
  encodeCustomModelValue,
  testId,
} from "@zcode/shared";
import {
  clickTestIdByDom,
  dispatchMouseDownByExactTestId,
  setInputValueByTestIdDom,
  waitForDefaultWorkspaceReady,
} from "./desktop-app.js";
import {
  ensureUpstreamProviderForE2E,
  selectUpstreamModel,
  selectUpstreamThoughtLevel,
} from "./upstream-provider.js";
import { readV4ChatRootSnapshotInBrowser } from "./conversation-session-chat-root-snapshot-script.js";
import { getTaskStoreSnapshot as readTaskStoreSnapshotForDiagnostics } from "./conversation-session-store.js";
import { sel } from "./selectors.js";
import { skipOccupationOnboardingIfPresent } from "./occupation-onboarding.js";

export const LOGIN_API_KEY = "e2e-login-api-key";
export const E2E_REPLY_TOKEN = "upstream-e2e-ok";

interface PrepareV4ConversationE2EOptions {
  resetDraftBeforeProvider?: boolean;
  skipProvider?: boolean;
}

/** 单 pane 竖切固定 paneId（V4ChatPane 写死 workspace-main）。 */
export const V4_MAIN_PANE_ID = "workspace-main";

export interface V4PaneSnapshot {
  /** data-session-id；draft 表示未绑定 CLI session。 */
  sessionId: string | null;
  initialDraftProvider: string;
  initialDraftModel: string;
  /** stop 按钮是否存在（= projection.control.canStop）。 */
  canStop: boolean;
  /** timeline 全部行文本（虚拟滚动下为当前渲染窗口内的行）。 */
  timelineText: string;
  rowCount: number;
}

export interface V4CompactMarkerSnapshot {
  origin: string | null;
  rowId: number | null;
  status: string | null;
  text: string;
}

export interface V4ConversationStateSnapshot {
  activeInputId: string | null;
  modelSwitchPending: boolean;
  queueCount: number;
  runtimeStatus: string | null;
  sessionId: string | null;
  state: string | null;
  stopRequested: boolean;
  targetId: string | null;
  targetObjective: string | null;
  targetStatus: string | null;
  taskId: string | null;
}

export interface V4MessageSnapshot {
  id: string | null;
  role: "assistant" | "user";
  text: string;
}

export async function prepareV4ConversationE2E(options: PrepareV4ConversationE2EOptions = {}) {
  await ensureV4ShellReady();
  if (options.resetDraftBeforeProvider) {
    // 修复原因：正式用例若停留在旧 active session，provider 初始化可能把默认模型
    // 写回旧 session；先切到 v4 空草稿，保持旧 helper 的隔离语义但不再依赖 legacy DOM。
    await startNewV4Draft();
  }
  if (!options.skipProvider) {
    await ensureUpstreamProviderForE2E({ skipToolbarSelection: true });
  }
  await startNewV4Draft();
  if (!options.skipProvider) {
    // 新 Composer 会保留已经初始化的空选择。仅写 Recent 不能覆盖这个草稿；
    // 测试准备必须像用户一样选择目标模型和档位，不能依赖旧初始化副作用。
    await selectUpstreamModel();
    await selectUpstreamThoughtLevel();
  }
}

async function ensureV4ShellReady() {
  try {
    // 新隔离 profile 的职业引导会遮住工作区，先复用真实 UI 跳过流程。
    await skipOccupationOnboardingIfPresent();
    await waitForDefaultWorkspaceReady(30000);
    return;
  } catch (error) {
    if (!(await hasApiKeyLoginButton())) {
      throw error;
    }
    await loginWithApiKey();
    await skipOccupationOnboardingIfPresent();
    await waitForDefaultWorkspaceReady(30000);
  }
}

async function hasApiKeyLoginButton() {
  const exists = await browser
    .execute(
      (currentTestId) => Boolean(document.querySelector(`[data-testid="${currentTestId}"]`)),
      TID_LOGIN_USE_API_KEY_BUTTON,
    )
    .catch(() => false);
  return Boolean(exists);
}

export async function loginWithApiKey() {
  await clickTestIdByDom(TID_LOGIN_USE_API_KEY_BUTTON, {
    timeout: 30000,
    timeoutMsg: "欢迎页没有出现 API Key 登录入口",
  });
  await setInputValueByTestIdDom(TID_LOGIN_API_KEY_INPUT, LOGIN_API_KEY, {
    timeout: 15000,
    timeoutMsg: "API Key 登录输入框没有出现",
  });
  await browser.waitUntil(
    async () =>
      browser.execute((continueButtonTestId) => {
        const button = document.querySelector<HTMLElement>(
          `[data-testid="${continueButtonTestId}"]`,
        );
        return button instanceof HTMLButtonElement && !button.disabled;
      }, TID_LOGIN_API_KEY_CONTINUE_BUTTON),
    {
      timeout: 15000,
      timeoutMsg: "API Key 登录继续按钮没有变为可用",
    },
  );
  await clickTestIdByDom(TID_LOGIN_API_KEY_CONTINUE_BUTTON, {
    timeout: 15000,
    timeoutMsg: "API Key 登录继续按钮没有出现或不可点击",
  });
}

/** 新建草稿：点侧栏新任务按钮，等 v4 pane 回到 draft 态。 */
export async function startNewV4Draft() {
  await clickTestIdByDom(TID_TASK_NEW_BUTTON, {
    timeout: 15000,
    timeoutMsg: "侧栏新任务按钮没有出现或不可点击",
  });
  await waitForV4Pane(
    (snapshot) => snapshot.sessionId === "draft",
    "新建任务后 v4 pane 没有回到 draft 态",
  );
}

export function getV4PaneSnapshot(paneId: string = V4_MAIN_PANE_ID): Promise<V4PaneSnapshot> {
  return browser.execute(
    (paneTestId, stopTestId, timelineTestId, rowPrefix) => {
      const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`);
      const timeline = pane?.querySelector<HTMLElement>(`[data-testid="${timelineTestId}"]`);
      return {
        sessionId: pane?.getAttribute("data-session-id") ?? null,
        initialDraftProvider: pane?.getAttribute("data-initial-draft-provider") ?? "",
        initialDraftModel: pane?.getAttribute("data-initial-draft-model") ?? "",
        canStop: Boolean(pane?.querySelector(`[data-testid="${stopTestId}"]`)),
        timelineText: (timeline?.innerText ?? "").replace(/ /g, " "),
        rowCount: pane?.querySelectorAll(`[data-testid^="${rowPrefix}-"]`).length ?? 0,
      };
    },
    testId(TID_V4_SESSION_PANE, paneId),
    TID_V4_STOP,
    TID_V4_TIMELINE,
    TID_V4_ROW,
  );
}

export async function waitForV4Pane(
  predicate: (snapshot: V4PaneSnapshot) => boolean,
  timeoutMsg: string,
  timeout = 30000,
  paneId: string = V4_MAIN_PANE_ID,
) {
  let latest: V4PaneSnapshot | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await getV4PaneSnapshot(paneId);
        return predicate(latest);
      },
      { timeout, timeoutMsg },
    );
  } catch (error) {
    latest = await getV4PaneSnapshot(paneId);
    throw new Error(`${timeoutMsg}; latest=${JSON.stringify(latest)}`, {
      cause: error,
    });
  }
  // 原因：会话切换时 pane 可能短暂经过 draft。waitUntil 已命中目标快照后若再读一次 DOM，
  // 调用方拿到的可能反而是下一帧过渡态，造成“条件通过但返回值不满足条件”的假失败。
  return latest ?? getV4PaneSnapshot(paneId);
}

export async function waitForV4ConversationState(
  predicate: (snapshot: V4ConversationStateSnapshot) => boolean,
  timeoutMsg: string,
  timeout = 30000,
) {
  let latest: V4ConversationStateSnapshot | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await getV4ConversationState();
        return predicate(latest);
      },
      { timeout, timeoutMsg },
    );
  } catch (error) {
    latest = await getV4ConversationState();
    throw new Error(`${timeoutMsg}; latest=${JSON.stringify(latest)}`, {
      cause: error,
    });
  }
  // 修复原因：命中 predicate 后再次读取会跨过 running/completed 瞬时边界，
  // 让调用方拿到与 waitUntil 判定不一致的状态。
  return latest ?? getV4ConversationState();
}

export async function getV4ConversationState(): Promise<V4ConversationStateSnapshot> {
  const browserSnapshot = await browser.execute(
    readV4ChatRootSnapshotInBrowser,
    testId(TID_V4_SESSION_PANE, V4_MAIN_PANE_ID),
    TID_V4_QUEUE_ITEM,
    TID_V4_STOP,
  );
  if (browserSnapshot.bridgeError) {
    throw new Error(
      `无法读取 V4 conversation workspace: ${browserSnapshot.bridgeError}; ` +
        `workspaceKey=${browserSnapshot.workspaceKey}; paneSessionId=${browserSnapshot.paneSessionId}`,
    );
  }

  if (!browserSnapshot.taskId) {
    return {
      activeInputId: null,
      modelSwitchPending: browserSnapshot.modelSwitchPending,
      queueCount: browserSnapshot.queueCount,
      runtimeStatus: browserSnapshot.runtimeStatus,
      sessionId: null,
      state: browserSnapshot.runtimeStatus === "streaming" ? "streaming" : "idle",
      stopRequested: false,
      targetId: null,
      targetObjective: null,
      targetStatus: null,
      taskId: null,
    };
  }

  const taskStore = await readTaskStoreSnapshotForDiagnostics(
    browserSnapshot.taskId,
    browserSnapshot.workspaceKey ?? undefined,
  );
  if (!taskStore.workspaceKey) {
    throw new Error(
      `无法读取 V4 conversation task: ${taskStore.error}; ` +
        `workspaceKey=${browserSnapshot.workspaceKey}; taskId=${browserSnapshot.taskId}`,
    );
  }

  const goalProjection = await browser.execute(
    (paneTestId, panelTestId) => {
      const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`);
      const panel = pane?.querySelector<HTMLElement>(`[data-testid="${panelTestId}"]`);
      if (!panel) return null;
      return {
        objective: panel.getAttribute("data-goal-objective"),
        status: panel.getAttribute("data-goal-status"),
      };
    },
    testId(TID_V4_SESSION_PANE, V4_MAIN_PANE_ID),
    TID_CHAT_SUMMARY_PANEL,
  );
  const hasBlockingGoalWork =
    goalProjection?.status === "active" || goalProjection?.status === "verifying";
  const effectiveRuntimeStatus =
    browserSnapshot.runtimeStatus === "streaming" ? "streaming" : taskStore.runtimeStatus;

  return {
    activeInputId: taskStore.activeInputId,
    modelSwitchPending: browserSnapshot.modelSwitchPending,
    queueCount: browserSnapshot.queueCount,
    runtimeStatus: effectiveRuntimeStatus,
    sessionId: browserSnapshot.taskId,
    state: effectiveRuntimeStatus === "streaming" || hasBlockingGoalWork ? "streaming" : "idle",
    stopRequested: taskStore.stopRequested,
    targetId: taskStore.taskMeta?.targetId ?? null,
    targetObjective: goalProjection?.objective ?? taskStore.taskMeta?.targetObjective ?? null,
    targetStatus: goalProjection?.status ?? taskStore.taskMeta?.targetStatus ?? null,
    taskId: browserSnapshot.taskId,
  };
}

/**
 * v4 composer 输入（M5 起为 Lexical contenteditable）：写入走
 * setInputValueByTestIdDom 的 __zcodeLexicalInputE2E bridge 分支（驱动真实 editor state）。
 */
export async function sendV4Prompt(prompt: string) {
  await setV4ComposerText(prompt);
  const mainPaneTestId = testId(TID_V4_SESSION_PANE, V4_MAIN_PANE_ID);
  try {
    await browser.waitUntil(
      async () =>
        browser.execute(
          (paneTestId, sendButtonTestId) => {
            const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`);
            const button = pane?.querySelector<HTMLButtonElement>(
              `[data-testid="${sendButtonTestId}"]`,
            );
            return Boolean(button && !button.disabled);
          },
          mainPaneTestId,
          TID_V4_COMPOSER_SEND,
        ),
      {
        timeout: 30000,
        timeoutMsg: "v4 发送按钮没有变为可用",
      },
    );
  } catch (error) {
    // 修复原因：会话切换竞态发生时，单独的“按钮 disabled”无法区分 projection connecting、
    // 上一轮仍在运行或 composer 未写入；把失败瞬间的 DOM 状态带回日志，避免继续靠猜测修复。
    const diagnostics = await browser.execute(
      (paneTestId, inputTestId, sendTestId, stopTestId) => {
        const panes = Array.from(
          document.querySelectorAll<HTMLElement>(`[data-testid^="${paneTestId}"]`),
        );
        const active = document.activeElement as HTMLElement | null;
        return {
          activeTestId: active?.getAttribute("data-testid") ?? null,
          panes: panes.map((pane) => {
            const input = pane.querySelector<HTMLElement>(`[data-testid="${inputTestId}"]`);
            const send = pane.querySelector<HTMLButtonElement>(`[data-testid="${sendTestId}"]`);
            return {
              paneTestId: pane.getAttribute("data-testid"),
              sessionId: pane.getAttribute("data-session-id"),
              inputText: input?.innerText ?? input?.textContent ?? null,
              sendDisabled: send?.disabled ?? null,
              sendTitle: send?.getAttribute("title") ?? null,
              canStop: Boolean(pane.querySelector(`[data-testid="${stopTestId}"]`)),
            };
          }),
        };
      },
      TID_V4_SESSION_PANE,
      TID_V4_COMPOSER_INPUT,
      TID_V4_COMPOSER_SEND,
      TID_V4_STOP,
    );
    throw new Error(`v4 发送按钮没有变为可用; diagnostics=${JSON.stringify(diagnostics)}`, {
      cause: error,
    });
  }
  const submitResult = await browser.execute(
    (paneTestId, sendButtonTestId) => {
      const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`);
      const button = pane?.querySelector<HTMLButtonElement>(`[data-testid="${sendButtonTestId}"]`);
      if (!pane) return { submitted: false, reason: "pane-missing" };
      if (!button) return { submitted: false, reason: "button-missing" };
      if (button.disabled) return { submitted: false, reason: "button-disabled" };

      const form = button.closest("form");
      if (!form) {
        button.click();
        return { submitted: true, method: "click-fallback" };
      }

      let submitEventSeen = false;
      const onSubmit = () => {
        submitEventSeen = true;
      };
      form.addEventListener("submit", onSubmit, { capture: true, once: true });
      form.requestSubmit(button);
      return {
        submitted: submitEventSeen,
        method: "request-submit",
        reason: submitEventSeen ? undefined : "submit-event-not-seen",
      };
    },
    mainPaneTestId,
    TID_V4_COMPOSER_SEND,
  );
  if (!submitResult.submitted) {
    throw new Error(`v4 composer 没有派发 submit 事件: ${JSON.stringify(submitResult)}`);
  }
}

/**
 * 发送普通 prompt 并等待 renderer 明确接受：主 pane composer 清空且真实 user row 出现。
 * 不重试 submit，避免首发已进入 Host、但慢渲染尚未投影时重复发送同一条消息。
 */
export async function sendV4PromptAndWaitAccepted(
  prompt: string,
  userMessageMarker: string,
  timeoutMsg: string,
  timeout = 60_000,
) {
  await sendV4Prompt(prompt);
  let latest: {
    composerText: string | null;
    paneExists: boolean;
    sendDisabled: boolean | null;
    sessionId: string | null;
    userMessageSeen: boolean;
  } | null = null;
  const readAcceptance = () =>
    browser.execute(
      (paneTestId, inputTestId, sendTestId, timelineTestId, marker) => {
        const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`);
        const input = pane?.querySelector<
          HTMLElement & { __zcodeLexicalInputE2E?: { getText: () => string } }
        >(`[data-testid="${inputTestId}"]`);
        const send = pane?.querySelector<HTMLButtonElement>(`[data-testid="${sendTestId}"]`);
        const timeline = pane?.querySelector<HTMLElement>(`[data-testid="${timelineTestId}"]`);
        const userMessageSeen = Array.from(
          timeline?.querySelectorAll<HTMLElement>("[data-row-id]") ?? [],
        ).some(
          (row) =>
            row.classList.contains("group/user-row") &&
            (row.innerText || row.textContent || "").includes(marker),
        );
        return {
          composerText: input?.__zcodeLexicalInputE2E?.getText() ?? null,
          paneExists: Boolean(pane),
          sendDisabled: send?.disabled ?? null,
          sessionId: pane?.getAttribute("data-session-id") ?? null,
          userMessageSeen,
        };
      },
      testId(TID_V4_SESSION_PANE, V4_MAIN_PANE_ID),
      TID_V4_COMPOSER_INPUT,
      TID_V4_COMPOSER_SEND,
      TID_V4_TIMELINE,
      userMessageMarker,
    );

  try {
    await browser.waitUntil(
      async () => {
        latest = await readAcceptance();
        return latest.composerText === "" && latest.userMessageSeen;
      },
      { timeout, timeoutMsg },
    );
  } catch (error) {
    latest = await readAcceptance().catch(() => latest);
    const state = await getV4ConversationState().catch((stateError) => ({
      error: stateError instanceof Error ? stateError.message : String(stateError),
    }));
    throw new Error(
      `${timeoutMsg}; acceptance=${JSON.stringify(latest)}; state=${JSON.stringify(state)}`,
      { cause: error },
    );
  }
}

/** 只写入 v4 composer，不触发发送。 */
export async function setV4ComposerText(text: string) {
  await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, text, {
    timeout: 15000,
    timeoutMsg: "v4 composer 输入框没有出现或不可输入",
  });
}

export async function waitForV4ComposerText(expected: string, timeoutMsg: string, timeout = 10000) {
  await browser.waitUntil(async () => (await getV4ComposerText()) === expected, {
    timeout,
    timeoutMsg,
  });
}

/** 点击 v4 composer 发送按钮（输入已由调用方写入，如 slash 命令）。 */
export async function clickV4Send() {
  await browser.waitUntil(
    async () =>
      browser.execute((sendButtonTestId) => {
        const button = document.querySelector<HTMLButtonElement>(
          `[data-testid="${sendButtonTestId}"]`,
        );
        return Boolean(button && !button.disabled);
      }, TID_V4_COMPOSER_SEND),
    {
      timeout: 30000,
      timeoutMsg: "v4 发送按钮没有变为可用",
    },
  );
  await clickTestIdByDom(TID_V4_COMPOSER_SEND, {
    timeout: 15000,
    timeoutMsg: "v4 发送按钮没有出现或不可点击",
  });
}

export async function waitForV4TimelineContaining(text: string, timeout = 60000) {
  await waitForV4Pane(
    (snapshot) => snapshot.timelineText.includes(text),
    `v4 timeline 中没有出现: ${text}`,
    timeout,
  );
}

/**
 * 只等待当前 V4 pane 的 assistant 正文，避免用户 prompt 中的同名 marker
 * 抢先满足完成屏障。formal case 不应为此回退到 legacy conversation helper。
 */
export async function waitForV4AssistantMessageContaining(
  text: string,
  timeout = 90000,
  paneId: string = V4_MAIN_PANE_ID,
) {
  let latestAssistantMessages: string[] = [];
  const readAssistantMessages = () =>
    browser.execute(
      (paneTestId, timelineTestId) => {
        const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`);
        const timeline = pane?.querySelector<HTMLElement>(`[data-testid="${timelineTestId}"]`);
        return Array.from(timeline?.querySelectorAll<HTMLElement>("[data-row-id]") ?? [])
          .filter((row) => row.classList.contains("group/assistant-row"))
          .map((row) => row.innerText.replace(/\u00a0/g, " ").trim());
      },
      testId(TID_V4_SESSION_PANE, paneId),
      TID_V4_TIMELINE,
    );

  try {
    await browser.waitUntil(
      async () => {
        latestAssistantMessages = await readAssistantMessages();
        return latestAssistantMessages.some((message) => message.includes(text));
      },
      {
        timeout,
        timeoutMsg: `v4 assistant 消息中没有出现: ${text}`,
      },
    );
  } catch (error) {
    latestAssistantMessages = await readAssistantMessages().catch(() => latestAssistantMessages);
    throw new Error(
      `v4 assistant 消息中没有出现: ${text}; latest=${JSON.stringify(latestAssistantMessages)}`,
      { cause: error },
    );
  }
}

export function getV4Messages(role?: "assistant" | "user"): Promise<V4MessageSnapshot[]> {
  return browser.execute(
    (paneTestId, timelineTestId, selectedRole) => {
      const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`);
      const timeline = pane?.querySelector<HTMLElement>(`[data-testid="${timelineTestId}"]`);
      return Array.from(timeline?.querySelectorAll<HTMLElement>("[data-row-id]") ?? [])
        .map((element) => {
          const currentRole = element.classList.contains("group/user-row")
            ? "user"
            : element.classList.contains("group/assistant-row")
              ? "assistant"
              : null;
          return {
            id: element.getAttribute("data-row-id"),
            role: currentRole,
            text: element.innerText.replace(/\u00a0/g, " ").trim(),
          };
        })
        .filter(
          (message): message is V4MessageSnapshot =>
            message.role !== null && (!selectedRole || message.role === selectedRole),
        );
    },
    testId(TID_V4_SESSION_PANE, V4_MAIN_PANE_ID),
    TID_V4_TIMELINE,
    role,
  );
}

export async function waitForV4UserMessageContaining(text: string) {
  let latestMessages: V4MessageSnapshot[] = [];
  try {
    await browser.waitUntil(
      async () => {
        latestMessages = await getV4Messages("user");
        return latestMessages.some((message) => message.text.includes(text));
      },
      {
        timeout: 60000,
        timeoutMsg: `v4 user 消息中没有出现: ${text}`,
      },
    );
  } catch (error) {
    const [state, composer, queue] = await Promise.all([
      getV4ConversationState().catch((stateError) => ({
        error: stateError instanceof Error ? stateError.message : String(stateError),
      })),
      getV4ComposerText().catch((composerError) =>
        composerError instanceof Error ? composerError.message : String(composerError),
      ),
      getV4QueueItems().catch((queueError) => [
        {
          queueItemId: "<queue-read-error>",
          text: queueError instanceof Error ? queueError.message : String(queueError),
        },
      ]),
    ]);
    throw new Error(
      `v4 user 消息中没有出现: ${text}; latestMessages=${JSON.stringify(latestMessages)}; state=${JSON.stringify(state)}; queue=${JSON.stringify(queue)}; composer=${JSON.stringify(composer)}`,
      { cause: error },
    );
  }
}

export async function assertVisibleV4UserMessagesNotContaining(text: string) {
  const messages = await getV4Messages("user");
  expect(messages.map((message) => message.text).join("\n")).not.toContain(text);
}

export async function clickV4Stop() {
  await clickTestIdByDom(TID_V4_STOP, {
    timeout: 30000,
    timeoutMsg: "v4 stop 按钮没有出现或不可点击",
  });
}

/** 点击第一个可见的 fork 按钮（完成态 assistant 行），返回是否点到。 */
export async function clickFirstV4Fork() {
  const buttons = await browser.$$('[data-testid^="v4-fork-"]');
  for (const button of buttons) {
    await moveV4ForkRowIntoHoverState(button);
    if (!(await button.isDisplayed()) || !(await button.isEnabled())) {
      continue;
    }
    // Bug 根因：直接在 renderer 里调用 HTMLElement.click() 会绕过 WebDriver 的
    // 用户交互路径；Radix/React 组合控件在长批次中可能只更新视觉层而未提交 fork。
    // 使用 WebDriver 原生 click，保留同一个按钮和断言语义，确保触发真实 pointer/click 事件。
    await button.click();
    return true;
  }
  return false;
}

export async function waitForV4Fork(timeout = 60000) {
  await browser.waitUntil(
    async () => {
      const buttons = await browser.$$('[data-testid^="v4-fork-"]');
      for (const button of buttons) {
        await moveV4ForkRowIntoHoverState(button);
        if ((await button.isDisplayed()) && (await button.isEnabled())) {
          return true;
        }
      }
      return false;
    },
    { timeout, timeoutMsg: "v4 fork 按钮没有出现（assistant 行未完成？）" },
  );
}

async function moveV4ForkRowIntoHoverState(button: WebdriverIO.Element): Promise<void> {
  const rowTestId = await browser.execute(
    (element) => element.closest<HTMLElement>("[data-row-id]")?.dataset.rowId ?? null,
    button,
  );
  const row = rowTestId ? await browser.$(`[data-row-id="${rowTestId}"]`) : await button.$("..");
  // Bug 根因：assistant action toolbar 默认由 group-hover 隐藏，旧 helper 只检查 DOM
  // 存在就直接点隐藏按钮；长列表中该 click 不会触发真实 fork。先把所属 turn 移入
  // hover 状态，再用可见且 enabled 的按钮完成同一用户操作，不改变 case 证明。
  await row.moveTo();
}

/** 点击第一个可见的 edit 按钮（user 行），返回是否点到。 */
export async function clickFirstV4Edit() {
  return browser.execute(() => {
    const btn = document.querySelector<HTMLButtonElement>('[data-testid^="v4-edit-"]');
    btn?.click();
    return Boolean(btn);
  });
}

export async function waitForV4Edit(timeout = 60000) {
  await browser.waitUntil(
    async () =>
      browser.execute((editPrefix) => {
        const exactPattern = new RegExp(`^${editPrefix}-\\d+$`);
        return Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).some(
          (candidate) => exactPattern.test(candidate.dataset.testid ?? ""),
        );
      }, TID_V4_EDIT),
    { timeout, timeoutMsg: "v4 edit 按钮没有出现（user 行未完成？）" },
  );
}

/** 读取 v4 queue 面板当前项数与文本。 */
export function getV4QueueItems(): Promise<Array<{ queueItemId: string; text: string }>> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll<HTMLElement>('li[data-testid^="v4-queue-item-"]'))
      // 修复原因：删除/编辑/立即发送按钮以及行内输入都共享
      // `v4-queue-item-*` 前缀和 data-queue-item-id；只按前缀会把一个 item
      // 统计成 4~5 个，误报 projection 没有显示 queue。列表项元素是唯一权威行。
      .filter((el) => el.hasAttribute("data-queue-item-id"))
      .map((el) => ({
        queueItemId: el.getAttribute("data-queue-item-id") ?? "",
        text: (el.innerText || "").replace(/ /g, " ").trim(),
      })),
  );
}

/** 读取 queue.autoDrain 权威 DOM 投影，供 fault/恢复 case 证明错误后不会自动消费。 */
export function getV4QueueAutoDrain(): Promise<boolean | null> {
  return browser.execute((queueTestId) => {
    const queue = document.querySelector<HTMLElement>(`[data-testid="${queueTestId}"]`);
    const value = queue?.getAttribute("data-queue-auto-drain");
    return value === null || value === undefined ? null : value === "true";
  }, TID_V4_QUEUE);
}

export async function waitForV4QueueCount(expected: number, timeout = 30000) {
  await browser.waitUntil(async () => (await getV4QueueItems()).length === expected, {
    timeout,
    timeoutMsg: `v4 queue 项数没有达到 ${expected}`,
  });
}

/** 点击某 queue 项的删除按钮（按 queueItemId）。 */
export async function clickV4QueueItemDelete(queueItemId: string) {
  return browser.execute((id) => {
    const btn = document.querySelector<HTMLButtonElement>(
      `[data-testid="v4-queue-item-delete-${id}"]`,
    );
    btn?.click();
    return Boolean(btn);
  }, queueItemId);
}

/** 点击某 queue 项的编辑按钮（按 queueItemId，撤回到 composer）。 */
export async function clickV4QueueItemEdit(queueItemId: string, clickCount = 1) {
  return browser.execute(
    (id, count) => {
      const btn = document.querySelector<HTMLButtonElement>(
        `[data-testid="v4-queue-item-edit-${id}"]`,
      );
      for (let index = 0; index < count; index += 1) {
        btn?.click();
      }
      return Boolean(btn);
    },
    queueItemId,
    clickCount,
  );
}

/** 点击某 queue 项的立即发送按钮（按 queueItemId）。 */
export async function clickV4QueueItemSendNow(queueItemId: string) {
  return browser.execute((id) => {
    const btn = document.querySelector<HTMLButtonElement>(
      `[data-testid="v4-queue-item-send-now-${id}"]`,
    );
    btn?.click();
    return Boolean(btn);
  }, queueItemId);
}

// ── 暂停队列发送确认与恢复（B06/B07/B14/B15/C08）──
// 原因：旧 E2E 把 clear/keep 当作 composer 的两颗替代发送按钮；产品交互改成
// 正常发送按钮先打开 modal 后，必须显式走“发送 → 等 modal → 选择”，否则测试会
// 把只打开弹窗误判成消息已经提交。

/** 暂停队列发送确认 modal 与两个操作按钮是否同时存在。 */
export function hasV4PausedQueueSendDialog(): Promise<boolean> {
  return browser.execute(
    (dialogTestId, clearTestId, keepTestId) =>
      Boolean(
        document.querySelector(`[data-testid="${dialogTestId}"]`) &&
        document.querySelector(`[data-testid="${clearTestId}"]`) &&
        document.querySelector(`[data-testid="${keepTestId}"]`),
      ),
    TID_V4_PAUSED_QUEUE_SEND_DIALOG,
    TID_V4_COMPOSER_CLEAR_QUEUE_SEND,
    TID_V4_COMPOSER_KEEP_QUEUE_SEND,
  );
}

/** 等待正常发送按钮提交后出现暂停队列确认 modal。 */
export async function waitForV4PausedQueueSendDialog(timeout = 30000) {
  await browser.waitUntil(async () => hasV4PausedQueueSendDialog(), {
    timeout,
    timeoutMsg: "暂停队列发送确认 modal 没有出现（清空/发送按钮缺失）",
  });
}

/** 通过正常发送按钮打开 modal，再选择“保留队列并发送”。 */
export async function sendV4PausedQueueKeep(prompt: string) {
  await sendV4Prompt(prompt);
  await waitForV4PausedQueueSendDialog();
  await clickTestIdByDom(TID_V4_COMPOSER_KEEP_QUEUE_SEND, {
    timeout: 15000,
    timeoutMsg: "暂停队列确认 modal 的“发送消息”按钮没有出现或不可点击",
  });
}

/** 通过正常发送按钮打开 modal，再选择“清空队列并发送”。 */
export async function sendV4PausedQueueClear(prompt: string) {
  await sendV4Prompt(prompt);
  await waitForV4PausedQueueSendDialog();
  await clickTestIdByDom(TID_V4_COMPOSER_CLEAR_QUEUE_SEND, {
    timeout: 15000,
    timeoutMsg: "暂停队列确认 modal 的“清空队列”按钮没有出现或不可点击",
  });
}

/** 暂停提示条与“继续”按钮是否同时存在。 */
export function hasV4PausedQueueBanner(): Promise<boolean> {
  return browser.execute(
    (bannerTestId, resumeTestId) =>
      Boolean(
        document.querySelector(`[data-testid="${bannerTestId}"]`) &&
        document.querySelector(`[data-testid="${resumeTestId}"]`),
      ),
    TID_V4_QUEUE_PAUSED_BANNER,
    TID_V4_QUEUE_RESUME,
  );
}

export async function waitForV4PausedQueueBanner(timeout = 30000) {
  await browser.waitUntil(async () => hasV4PausedQueueBanner(), {
    timeout,
    timeoutMsg: "暂停队列提示条或“继续”按钮没有出现",
  });
}

/** 点击暂停队列提示条的“继续”，恢复 CLI FIFO 自动消费。 */
export async function clickV4PausedQueueResume() {
  await waitForV4PausedQueueBanner();
  await clickTestIdByDom(TID_V4_QUEUE_RESUME, {
    timeout: 15000,
    timeoutMsg: "暂停队列提示条的“继续”按钮没有出现或不可点击",
  });
}

/** 读取后台工作面板项（workId + status）。 */
export function getV4BackgroundWorks(): Promise<Array<{ workId: string; status: string | null }>> {
  return browser.execute((itemPrefix) => {
    return Array.from(
      document.querySelectorAll<HTMLElement>(`[data-testid^="${itemPrefix}-"]`),
    ).map((el) => ({
      workId: el.getAttribute("data-work-id") ?? "",
      status: el.getAttribute("data-work-status"),
    }));
  }, TID_V4_BACKGROUND_WORK_ITEM);
}

/** 读取 Composer 当前 session 的后台任务计数与响应式展示形态；无入口返回 null。 */
export function getV4ComposerBackgroundWorkCounts(): Promise<{
  bashCount: number;
  workflowCount: number;
  subagentCount: number;
  totalCount: number;
  /** 入口点击的落点（docs/dynamic-workflow/presentation.md）："panel" | "workflow-run"。 */
  openTarget: string;
  typedVisible: boolean;
  compactVisible: boolean;
} | null> {
  return browser.execute((triggerTestId) => {
    const trigger = document.querySelector<HTMLElement>(`[data-testid="${triggerTestId}"]`);
    if (!trigger) return null;
    const isVisible = (layout: string) => {
      const element = trigger.querySelector<HTMLElement>(
        `[data-composer-background-layout="${layout}"]`,
      );
      return Boolean(element && getComputedStyle(element).display !== "none");
    };
    return {
      bashCount: Number(trigger.dataset.backgroundBashCount ?? "0"),
      workflowCount: Number(trigger.dataset.backgroundWorkflowCount ?? "0"),
      subagentCount: Number(trigger.dataset.backgroundSubagentCount ?? "0"),
      totalCount: Number(trigger.dataset.backgroundTotalCount ?? "0"),
      openTarget: trigger.dataset.backgroundOpenTarget ?? "panel",
      typedVisible: isVisible("typed"),
      compactVisible: isVisible("compact"),
    };
  }, TID_V4_COMPOSER_BACKGROUND_WORK_TRIGGER);
}

/** Electron driver 不实现 WebDriver window/rect；通过主进程 BrowserWindow 调整 viewport。 */
export async function setV4ElectronWindowSize(width: number, height: number) {
  const resized = await browser.electron.execute(
    (electron, nextWidth, nextHeight) => {
      const window = electron.BrowserWindow.getAllWindows().find(
        (candidate) => !candidate.isDestroyed() && candidate.isVisible(),
      );
      if (!window) return false;
      const bounds = window.getBounds();
      window.setBounds({ ...bounds, width: nextWidth, height: nextHeight });
      window.focus();
      return true;
    },
    width,
    height,
  );
  if (!resized) {
    throw new Error("没有找到可调整尺寸的 Electron 窗口");
  }
  await browser.waitUntil(
    async () =>
      browser.execute(
        (expectedWidth, expectedHeight) =>
          Math.abs(window.innerWidth - expectedWidth) < 80 &&
          Math.abs(window.innerHeight - expectedHeight) < 120,
        width,
        height,
      ),
    { timeout: 10000, timeoutMsg: `Electron 窗口尺寸没有收敛到 ${width}x${height}` },
  );
}

/** 从 Composer 单一入口展开 Status panel，并直达所有非空后台类型区块。 */
export async function openV4ComposerRunningBackgroundWorks(timeout = 30000) {
  await clickTestIdByDom(TID_V4_COMPOSER_BACKGROUND_WORK_TRIGGER, {
    timeout,
    timeoutMsg: "Composer 后台任务入口没有出现或不可点击",
  });
  await browser.waitUntil(
    async () =>
      browser.execute(
        (panelTestId, itemPrefix) => {
          const panel = document.querySelector<HTMLElement>(`[data-testid="${panelTestId}"]`);
          const terminalCount = Number(panel?.dataset.runningTerminalCount ?? "0");
          const agentCount = Number(panel?.dataset.runningAgentCount ?? "0");
          const terminalTrigger = panel?.querySelector<HTMLElement>(
            '[data-status-section-trigger="terminal"]',
          );
          const agentTrigger = panel?.querySelector<HTMLElement>(
            '[data-status-section-trigger="agent"]',
          );
          return Boolean(
            panel?.dataset.state === "expanded" &&
            (terminalCount === 0 || terminalTrigger?.getAttribute("aria-expanded") === "true") &&
            (agentCount === 0 || agentTrigger?.getAttribute("aria-expanded") === "true") &&
            panel.querySelector(`[data-testid^="${itemPrefix}-"]`),
          );
        },
        TID_CHAT_SUMMARY_PANEL,
        TID_V4_BACKGROUND_WORK_ITEM,
      ),
    { timeout, timeoutMsg: "Composer 入口没有直达展开的终端/智能体明细" },
  );
}

/** 展开统一 status panel 的非空后台类型区块；定位只依赖结构化属性，不依赖中英文。 */
export async function openV4RunningBackgroundWorks(timeout = 30000) {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (panelTestId, itemPrefix) => {
          const panel = document.querySelector<HTMLElement>(`[data-testid="${panelTestId}"]`);
          if (!panel || Number(panel.dataset.runningBackgroundCount ?? "0") < 1) {
            return false;
          }
          if (panel.dataset.state === "collapsed") {
            panel.querySelector<HTMLButtonElement>("button")?.click();
            return false;
          }
          const sections = [
            {
              count: Number(panel.dataset.runningTerminalCount ?? "0"),
              name: "terminal",
            },
            {
              count: Number(panel.dataset.runningAgentCount ?? "0"),
              name: "agent",
            },
          ];
          let allOpen = true;
          for (const section of sections) {
            if (section.count === 0) continue;
            const trigger = panel.querySelector<HTMLButtonElement>(
              `[data-status-section-trigger="${section.name}"]`,
            );
            if (!trigger) return false;
            if (trigger.getAttribute("aria-expanded") !== "true") {
              trigger.click();
              allOpen = false;
            }
          }
          return allOpen && Boolean(panel.querySelector(`[data-testid^="${itemPrefix}-"]`));
        },
        TID_CHAT_SUMMARY_PANEL,
        TID_V4_BACKGROUND_WORK_ITEM,
      ),
    { timeout, timeoutMsg: "status panel 没有展开终端/智能体 background work" },
  );
}

export function getLatestV4CommandAck(type: string): Promise<{
  type: string;
  status: string;
  reasonCode?: string;
} | null> {
  return browser.execute((commandType) => {
    const entries =
      (
        window as Window & {
          __zcodeV4CommandAcksE2E?: Array<{
            type: string;
            status: string;
            reasonCode?: string;
          }>;
        }
      ).__zcodeV4CommandAcksE2E ?? [];
    return [...entries].reverse().find((entry) => entry.type === commandType) ?? null;
  }, type);
}

/** 等待指定 v4 command 的结构化 ACK，避免业务断言把 command 卡住误报成模型无回复。 */
export async function waitForLatestV4CommandAck(type: string, timeout = 30000) {
  let latest: Awaited<ReturnType<typeof getLatestV4CommandAck>> = null;
  await browser.waitUntil(
    async () => {
      latest = await getLatestV4CommandAck(type);
      return latest !== null;
    },
    { timeout, timeoutMsg: `v4 command 没有返回 ACK: ${type}` },
  );
  return latest!;
}

/** 点击某后台工作的取消按钮（cancelBackgroundWork 命令，按 workId）。 */
export async function clickV4BackgroundWorkCancel(workId: string) {
  return browser.execute((id) => {
    const btn = document.querySelector<HTMLButtonElement>(
      `[data-testid="v4-background-work-cancel-${id}"]`,
    );
    btn?.click();
    return Boolean(btn);
  }, workId);
}

/** 点击会话删除按钮（deleteSession 命令）。 */
export async function clickV4DeleteSession() {
  return clickTestIdByDom(TID_V4_DELETE_SESSION, {
    timeout: 15000,
    timeoutMsg: "v4 删除按钮没有出现",
  });
}

/** 读取 Composer 当前 mode/模型选择显示。 */
export function getV4ModelConfig(): Promise<{
  mode: string | null;
  provider: string | null;
  model: string | null;
  source: string | null;
  thought: string | null;
}> {
  return browser.execute((modelTestId) => {
    const el = document.querySelector<HTMLElement>(`[data-testid="${modelTestId}"]`);
    return {
      mode: el?.getAttribute("data-mode") ?? null,
      provider: el?.getAttribute("data-provider") ?? null,
      model: el?.getAttribute("data-model") ?? null,
      source: el?.getAttribute("data-source") ?? null,
      thought: el?.getAttribute("data-thought") ?? null,
    };
  }, TID_V4_MODEL_CONFIG);
}

/** 等待当前 Composer 已从持久 Draft 完成 mode/模型选择初始化。 */
export async function waitForV4ComposerSelectionReady(timeout = 30_000) {
  let latest = await getV4ModelConfig();
  await browser.waitUntil(
    async () => {
      latest = await getV4ModelConfig();
      return (
        latest.source === "composer" &&
        Boolean(latest.mode?.trim()) &&
        Boolean(latest.provider?.trim()) &&
        Boolean(latest.model?.trim())
      );
    },
    {
      timeout,
      timeoutMsg: `v4 Composer 选择没有就绪: ${JSON.stringify(latest)}`,
    },
  );
}

/** 读取 draft 当前模型及其思考档位；V4 投影优先，legacy 目录仅作水合前 fallback。 */
export function getV4DraftThoughtState(workspacePath: string): Promise<{
  current: string | null;
  model: string | null;
  values: string[];
}> {
  return browser.execute(
    (path, modelTestId) => {
      const e2eWindow = window as Window & {
        __zcodeSessionStoreE2E?: {
          getState: () => {
            getWorkspaceState?: (workspacePath: string) => {
              configOptions?: Array<{
                category?: string;
                currentValue?: unknown;
                options?: Array<{ value: string }>;
              }>;
            };
          };
        };
      };
      const options =
        e2eWindow.__zcodeSessionStoreE2E?.getState().getWorkspaceState?.(path).configOptions ?? [];
      const model = options.find((option) => option.category === "model");
      const thought = options.find((option) => option.category === "thought_level");
      const v4Config = document.querySelector<HTMLElement>(`[data-testid="${modelTestId}"]`);
      const v4ThoughtLevels = (v4Config?.dataset.thoughtLevels ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      return {
        current:
          v4Config?.dataset.thought?.trim() ||
          (typeof thought?.currentValue === "string" ? thought.currentValue : null),
        model:
          v4Config?.dataset.model?.trim() ||
          (typeof model?.currentValue === "string" ? model.currentValue : null),
        values:
          v4ThoughtLevels.length > 0
            ? v4ThoughtLevels
            : (thought?.options?.map((option) => option.value) ?? []),
      };
    },
    workspacePath,
    TID_V4_MODEL_CONFIG,
  );
}

/**
 * 通过 composer 工具条切换模型 + 思考深度（switchModelConfig 命令）。
 * M5：调试表单（provider/model/thought 文本框 + 应用）已被真实模型选择器替换——
 * helper 适配为驱动 ModelConfigSelect（含 provider 分组二级菜单）与思考深度选择器，
 * spec 的断言语义不变（config 投影更新为目标值）。
 */
export async function switchV4Model(provider: string, model: string, thought: string) {
  // 1) 模型：打开菜单 → （必要时展开 provider 分组子菜单）→ 点目标模型项。
  const modelItemTestId = testId(
    TID_CHAT_MODEL_SELECT_ITEM,
    encodeCustomModelValue(provider, model),
  );
  const providerGroupTestIds = [
    testId(TID_CHAT_MODEL_SELECT_GROUP, `registry-provider:${provider}`),
  ];
  // 模型菜单是受控 DropdownMenu（pointerdown 打开），element.click() 不触发；
  // 与旧 upstream helper 同口径用 WebDriver 真实点击。
  const modelTrigger = $(sel(TID_CHAT_MODEL_SELECT_TRIGGER));
  await modelTrigger.waitForClickable({ timeout: 30000 });
  await modelTrigger.click();
  await browser.waitUntil(
    async () =>
      browser.execute(
        (itemTestId, groupTestIds) => {
          const item = document.querySelector<HTMLElement>(`[data-testid="${itemTestId}"]`);
          if (item) {
            item.click();
            return true;
          }
          // 自定义 provider 模型在二级菜单：先触发分组展开（hover + click 双保险）。
          const group = groupTestIds
            .map((groupTestId) =>
              document.querySelector<HTMLElement>(`[data-testid="${groupTestId}"]`),
            )
            .find((candidate): candidate is HTMLElement => Boolean(candidate));
          if (group) {
            group.focus();
            for (const eventName of ["pointerenter", "mouseenter", "mousemove"] as const) {
              group.dispatchEvent(
                new MouseEvent(eventName, {
                  bubbles: true,
                  cancelable: true,
                  view: window,
                }),
              );
            }
            group.click();
          }
          return false;
        },
        modelItemTestId,
        providerGroupTestIds,
      ),
    {
      timeout: 45000,
      timeoutMsg: `v4 模型选择器没有出现目标模型项: ${provider}/${model}`,
    },
  );

  // 模型 config 投影落定后再切思考深度：thought 命令的 provider/model 参数取自
  // 最新投影，模型切换未回流前切 thought 会被 UI 跳过（config-empty 防御）。
  await browser.waitUntil(async () => (await getV4ModelConfig()).model === model, {
    timeout: 30000,
    timeoutMsg: `模型切换后 config.model 投影没有更新为 ${model}`,
  });

  // 无 reasoning metadata 的 custom provider 不渲染 thought selector。协议类 E2E
  // 传空值表示只切模型，不能把不存在的思考深度控件当作模型切换失败。
  if (!thought) {
    return;
  }

  // 2) 思考深度：Radix Select 的 item 在真实 pointer 事件上确认（element.click() 无效），
  // trigger/item 都用 WebDriver 真实点击。
  await selectRadixOption(
    TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER,
    testId(TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM, thought),
    `v4 思考深度选择器没有出现目标档位: ${thought}`,
  );
}

/** Radix Select 通用驱动：真实点击 trigger 展开，item 需要完整 pointer 手势才会确认。 */
async function selectRadixOption(triggerTestId: string, itemTestId: string, timeoutMsg: string) {
  const trigger = $(sel(triggerTestId));
  await trigger.waitForClickable({ timeout: 30000 });
  await trigger.click();
  const item = $(sel(itemTestId));
  try {
    await item.waitForClickable({ timeout: 15000 });
  } catch (error) {
    throw new Error(timeoutMsg, { cause: error });
  }
  // Radix SelectItem 的确认：mouse 手势要求 trusted pointer 链路（合成事件被手势
  // 判定忽略），键盘路径（item 聚焦 + Enter，SELECTION_KEYS）是自动化下最稳的确认方式。
  const confirmResult = await browser.execute((currentTestId) => {
    const element = document.querySelector<HTMLElement>(`[data-testid="${currentTestId}"]`);
    if (!element) {
      return {
        ok: false,
        reason: "item-missing",
        testIds: Array.from(document.querySelectorAll<HTMLElement>("[data-testid]"))
          .map((el) => el.dataset.testid ?? "")
          .filter((id) => id.includes("select"))
          .slice(0, 40),
      };
    }
    element.focus();
    const focused = document.activeElement === element;
    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
    return { ok: true, focused };
  }, itemTestId);
  if (!confirmResult || confirmResult.ok !== true) {
    throw new Error(`${timeoutMsg}（item 确认阶段异常: ${JSON.stringify(confirmResult)}）`);
  }
  // 选择生效 ⇔ SelectContent 卸载（item 消失）；未关闭说明确认未生效，抛诊断。
  await browser
    .waitUntil(
      async () =>
        browser.execute(
          (currentTestId) => !document.querySelector(`[data-testid="${currentTestId}"]`),
          itemTestId,
        ),
      { timeout: 5000 },
    )
    .catch(() => {
      throw new Error(`${timeoutMsg}（item 确认后菜单未关闭——选择未生效）`);
    });
}

/** 读取 goal 横幅（data-goal-status / data-goal-objective 投影属性）；无目标返回 null。 */
export function getV4GoalProjection(): Promise<{
  status: string | null;
  objective: string | null;
} | null> {
  return browser.execute(
    (paneTestId, paneId, panelTestId) => {
      const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}-${paneId}"]`);
      const el = pane?.querySelector<HTMLElement>(`[data-testid="${panelTestId}"]`);
      if (!el) return null;
      return {
        status: el.getAttribute("data-goal-status"),
        objective: el.getAttribute("data-goal-objective"),
      };
    },
    TID_V4_SESSION_PANE,
    V4_MAIN_PANE_ID,
    TID_CHAT_SUMMARY_PANEL,
  );
}

/** 打开 latest user query 行内编辑并填入新文本，但不提交。 */
export async function beginFirstV4UserQueryEdit(newText: string) {
  let rowId: string | null = null;
  let lastClickedRowId: string | null = null;
  let lastClickedAt = 0;
  await browser.waitUntil(
    async () => {
      const state = await browser.execute(
        (editPrefix, editInputPrefix) => {
          const actionPattern = new RegExp(`^${editPrefix}-(\\d+)$`);
          const inputPattern = new RegExp(`^${editInputPrefix}-(\\d+)$`);
          const testIds = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]"));
          const input = testIds
            .filter((candidate) => inputPattern.test(candidate.dataset.testid ?? ""))
            .at(-1);
          if (input) {
            return {
              inputRowId: inputPattern.exec(input.dataset.testid ?? "")?.[1] ?? null,
              actionRowId: null,
            };
          }
          const action = testIds
            .filter((candidate) => actionPattern.test(candidate.dataset.testid ?? ""))
            .at(-1);
          return {
            inputRowId: null,
            actionRowId: actionPattern.exec(action?.dataset.testid ?? "")?.[1] ?? null,
          };
        },
        TID_V4_EDIT,
        TID_V4_EDIT_INPUT,
      );
      if (state.inputRowId) {
        rowId = state.inputRowId;
        return true;
      }
      if (!state.actionRowId) return false;

      const now = Date.now();
      if (lastClickedRowId !== state.actionRowId || now - lastClickedAt >= 500) {
        lastClickedRowId = state.actionRowId;
        lastClickedAt = now;
        await clickTestIdByDom(testId(TID_V4_EDIT, state.actionRowId), {
          timeout: 2000,
          timeoutMsg: `v4 行内编辑按钮在 projection 收口时消失: rowId=${state.actionRowId}`,
        }).catch(() => undefined);
      }
      return false;
    },
    {
      timeout: 15000,
      timeoutMsg: "v4 latest user edit action 出现后没有进入稳定行内编辑态",
      interval: 100,
    },
  );
  if (!rowId) {
    throw new Error("v4 latest user edit action 没有出现");
  }
  // Bug 根因：compact success 会先投影成功 marker，再清理 active work；这两帧之间
  // 旧 edit action 可能短暂可见后被 canEdit 收口撤下。单次 DOM click 会把刚打开的
  // 本地 editing 状态随 onEdit 消失一起关闭。等待稳定 input，并在 action 恢复后重试。
  await setInputValueByTestIdDom(testId(TID_V4_EDIT_INPUT, rowId), newText, {
    timeout: 15000,
    timeoutMsg: `v4 行内编辑输入框没有出现: rowId=${rowId}`,
  });
  return rowId;
}

/** 按真实行内编辑交互提交 latest user query，主 composer 草稿不参与。 */
export async function editFirstV4UserQuery(newText: string) {
  const rowId = await beginFirstV4UserQueryEdit(newText);
  await clickTestIdByDom(testId(TID_V4_EDIT_SUBMIT, rowId), {
    timeout: 15000,
    timeoutMsg: `v4 行内编辑提交按钮没有出现: rowId=${rowId}`,
  });
  return rowId;
}

/** 提交行内编辑的“对话 + 文件重置”路径。 */
export async function clickV4EditWorkspaceReset(rowId: string) {
  await clickTestIdByDom(testId(TID_V4_EDIT_REWIND_WORKSPACE, rowId), {
    timeout: 15000,
    timeoutMsg: `v4 对话 + 文件重置按钮没有出现或不可点击: rowId=${rowId}`,
  });
}

export async function waitForV4EditWorkspaceConflict(timeout = 30000) {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (testIdValue) => Boolean(document.querySelector(`[data-testid="${testIdValue}"]`)),
        TID_V4_EDIT_WORKSPACE_CONFLICT_DIALOG,
      ),
    { timeout, timeoutMsg: "v4 edit 文件冲突弹窗没有出现" },
  );
}

export async function clickV4EditConflictConversationOnly() {
  await clickTestIdByDom(TID_V4_EDIT_WORKSPACE_CONFLICT_CONVERSATION_ONLY, {
    timeout: 15000,
    timeoutMsg: "v4 edit 冲突弹窗没有出现仅重置对话按钮",
  });
}

/** 读取结构化 compact marker；状态与来源只读 data-*，不依赖本地化 label。 */
export function getV4CompactMarkers(
  paneId: string = V4_MAIN_PANE_ID,
): Promise<V4CompactMarkerSnapshot[]> {
  return browser.execute(
    (paneTestId, rowPrefix) => {
      const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`);
      return Array.from(
        pane?.querySelectorAll<HTMLElement>(
          `[data-testid^="${rowPrefix}-"][data-row-kind="timelineMarker"][data-marker-type="compact"]`,
        ) ?? [],
      ).map((row) => {
        const rowId = row.dataset.rowId ? Number(row.dataset.rowId) : Number.NaN;
        return {
          origin: row.dataset.origin ?? null,
          rowId: Number.isFinite(rowId) ? rowId : null,
          status: row.dataset.status ?? null,
          text: row.innerText.trim(),
        };
      });
    },
    testId(TID_V4_SESSION_PANE, paneId),
    TID_V4_ROW,
  );
}

/** 等待结构化 compact marker；不读取本地化 label。 */
export async function waitForV4CompactMarker(
  expected: { status: string; origin: "manual" | "auto" },
  timeout = 90000,
) {
  await browser.waitUntil(
    async () =>
      (await getV4CompactMarkers()).some(
        (marker) => marker.status === expected.status && marker.origin === expected.origin,
      ),
    {
      timeout,
      timeoutMsg: `v4 compact marker 未达到 ${expected.origin}/${expected.status}`,
    },
  );
}

/** 读取会话标题显示（data-title 投影属性）。 */
export function getV4SessionTitle(): Promise<string | null> {
  return browser.execute((titleTestId) => {
    const el = document.querySelector<HTMLElement>(`[data-testid="${titleTestId}"]`);
    return el?.getAttribute("data-title") ?? null;
  }, TID_V4_SESSION_TITLE);
}

/** 在 header 重命名输入框写入标题并点提交（renameSession 命令）。 */
export async function renameV4Session(title: string) {
  await setInputValueByTestIdDom(TID_V4_RENAME_INPUT, title, {
    timeout: 15000,
    timeoutMsg: "v4 重命名输入框没有出现",
  });
  await clickTestIdByDom(TID_V4_RENAME_SUBMIT, {
    timeout: 15000,
    timeoutMsg: "v4 重命名提交按钮没有出现",
  });
}

/** 读取输入控制条：autoDrain（data-auto-drain）与 followupMode（data-followup-mode）。 */
export function getV4InputControlState(): Promise<{
  autoDrain: string | null;
  followupMode: string | null;
}> {
  return browser.execute(
    (autoDrainTestId, followupTestId) => {
      const autoBtn = document.querySelector<HTMLElement>(`[data-testid="${autoDrainTestId}"]`);
      const followupBtn = document.querySelector<HTMLElement>(`[data-testid="${followupTestId}"]`);
      return {
        autoDrain: autoBtn?.getAttribute("data-auto-drain") ?? null,
        followupMode: followupBtn?.getAttribute("data-followup-mode") ?? null,
      };
    },
    TID_V4_AUTODRAIN_TOGGLE,
    TID_V4_FOLLOWUP_TOGGLE,
  );
}

/** 点击 autoDrain 开关（setAutoDrain 命令）。 */
export async function clickV4AutoDrainToggle() {
  return clickTestIdByDom(TID_V4_AUTODRAIN_TOGGLE, {
    timeout: 15000,
    timeoutMsg: "v4 autoDrain 开关没有出现",
  });
}

/** 点击 followupMode 开关（setFollowupMode 命令）。 */
export async function clickV4FollowupToggle() {
  return clickTestIdByDom(TID_V4_FOLLOWUP_TOGGLE, {
    timeout: 15000,
    timeoutMsg: "v4 followupMode 开关没有出现",
  });
}

/** 拖拽某 queue 项到目标 queue 项上（按 queueItemId）。 */
export async function dragV4QueueItemOnto(sourceQueueItemId: string, targetQueueItemId: string) {
  const positions = (await browser.execute(
    (sourceId, targetId) => {
      const dragHandle = Array.from(
        document.querySelectorAll<HTMLElement>('[data-v4-queue-drag-handle="true"]'),
      ).find((el) => el.getAttribute("data-queue-item-id") === sourceId);
      const targetItem = Array.from(
        document.querySelectorAll<HTMLElement>("li[data-queue-item-id]"),
      ).find((el) => el.getAttribute("data-queue-item-id") === targetId);

      if (!dragHandle || !targetItem) {
        return {
          ok: false,
          reason: "missing-element",
          hasDragHandle: Boolean(dragHandle),
          hasTargetItem: Boolean(targetItem),
        };
      }

      const dragRect = dragHandle.getBoundingClientRect();
      const targetRect = targetItem.getBoundingClientRect();
      return {
        ok: true,
        startX: Math.round(dragRect.left + dragRect.width / 2),
        startY: Math.round(dragRect.top + dragRect.height / 2),
        endX: Math.round(targetRect.left + targetRect.width / 2),
        endY: Math.round(targetRect.top + targetRect.height / 2),
      };
    },
    sourceQueueItemId,
    targetQueueItemId,
  )) as
    | { ok: true; startX: number; startY: number; endX: number; endY: number }
    | {
        ok: false;
        reason: string;
        hasDragHandle: boolean;
        hasTargetItem: boolean;
      };

  if (!positions.ok) {
    throw new Error(`v4 队列项拖拽元素不存在: ${JSON.stringify(positions)}`);
  }

  await browser.performActions([
    {
      id: "v4-queue-drag-pointer",
      type: "pointer",
      parameters: { pointerType: "mouse" },
      actions: [
        {
          type: "pointerMove",
          duration: 0,
          x: positions.startX,
          y: positions.startY,
        },
        { type: "pointerDown", button: 0 },
        { type: "pause", duration: 80 },
        {
          type: "pointerMove",
          duration: 120,
          x: positions.startX,
          y: positions.startY - 10,
        },
        {
          type: "pointerMove",
          duration: 260,
          x: positions.endX,
          y: positions.endY,
        },
        { type: "pointerUp", button: 0 },
      ],
    },
  ]);
  await browser.releaseActions();

  // 修复原因：dnd-kit 会屏蔽拖拽结束后的紧随 click，E2E 用空白 click 消耗这次屏蔽，
  // 避免后续按钮点击被误吞。
  await browser.execute(() => {
    document.body.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        view: window,
      }),
    );
  });
  await browser.pause(50);
}

// ── M5④ 虚拟滚动：timeline 滚动状态读写 ──
// 虚拟化后 DOM 只有挂载的 turn units；raw 行数分别走 timeline 容器的
// data-window-row-count（rows.window）与 data-total-row-count（rows.totalCount），
// 避免把 mounted unit、logical unit 与持久 raw row 三种计量单位混用。

export interface V4TimelineScrollState {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  /** raw projection window 行数。 */
  windowRowCount: number;
  /** turn-level logical render unit 数。 */
  renderUnitCount: number;
  /** 全序行数（data-total-row-count）。 */
  totalRowCount: number;
  /** 底部跟随态（data-following："true" | "false"）。 */
  following: string | null;
  /** 实际挂载到 DOM 的 turn unit 数（虚拟化窗口 + overscan）。 */
  mountedRenderUnitCount: number;
  /** 「回到底部」按钮是否出现。 */
  hasBackToBottom: boolean;
}

export function getV4TimelineScrollState(): Promise<V4TimelineScrollState> {
  return browser.execute(
    (timelineTestId, bottomTestId) => {
      const timeline = document.querySelector<HTMLElement>(`[data-testid="${timelineTestId}"]`);
      return {
        scrollTop: timeline?.scrollTop ?? 0,
        scrollHeight: timeline?.scrollHeight ?? 0,
        clientHeight: timeline?.clientHeight ?? 0,
        windowRowCount: Number(timeline?.getAttribute("data-window-row-count") ?? 0),
        renderUnitCount: Number(timeline?.getAttribute("data-render-unit-count") ?? 0),
        totalRowCount: Number(timeline?.getAttribute("data-total-row-count") ?? 0),
        following: timeline?.getAttribute("data-following") ?? null,
        mountedRenderUnitCount:
          timeline?.querySelectorAll('[data-v4-turn-unit="true"]').length ?? 0,
        hasBackToBottom: Boolean(document.querySelector(`[data-testid="${bottomTestId}"]`)),
      };
    },
    TID_V4_TIMELINE,
    TID_V4_TIMELINE_BOTTOM,
  );
}

/**
 * 把 timeline 滚到顶（scrollTop=0，触发原生 scroll 事件 → 解除底部跟随），
 * 并等虚拟化窗口对齐到新滚动位置后才返回。
 *
 * bugfix（虚拟化语义）：scrollTop 赋值后 scroll 事件要到下一渲染帧才派发，
 * virtualizer 收到事件才重渲染顶端行——期间 DOM 仍是旧的底部窗口
 * （实测：scrollTop=0 后旧行 58..72 还挂在视口下方 3272px 处），此时视口里没有
 * 任何行。CDP execute 往返快于一帧，调用方紧接着的 DOM 采样会读到过期窗口。
 * 这里等「有行真正落进视口」（虚拟窗口已对齐当前滚动位置）再返回。
 * 注意不能等 scrollTop 停在 0：到顶会触发 loadOlder，prepend 锚定会立刻把
 * scrollTop 平移到保持阅读位置的新值（这正是被测语义），0 只是瞬态。
 */
export async function scrollV4TimelineToTop() {
  await browser.execute((timelineTestId) => {
    const timeline = document.querySelector<HTMLElement>(`[data-testid="${timelineTestId}"]`);
    if (!timeline) return;
    // 修复原因：ConversationTimeline 会先用 wheel/touch/key 记录真实用户意图，
    // 仅写 scrollTop 的脚本滚动可能被布局保护窗口归类为虚拟化校正，继续保持底部跟随。
    timeline.dispatchEvent(
      new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -600 }),
    );
    timeline.scrollTop = 0;
    timeline.dispatchEvent(new Event("scroll"));
  }, TID_V4_TIMELINE);
  await browser.waitUntil(
    async () =>
      browser.execute(
        (timelineTestId, rowPrefix) => {
          const timeline = document.querySelector<HTMLElement>(`[data-testid="${timelineTestId}"]`);
          if (!timeline) return false;
          const timelineTop = timeline.getBoundingClientRect().top;
          const viewportHeight = timeline.clientHeight;
          return Array.from(
            timeline.querySelectorAll<HTMLElement>(`[data-testid^="${rowPrefix}-"]`),
          ).some((row) => {
            const rect = row.getBoundingClientRect();
            return rect.bottom - timelineTop > 0 && rect.top - timelineTop < viewportHeight;
          });
        },
        TID_V4_TIMELINE,
        TID_V4_ROW,
      ),
    {
      timeout: 15000,
      timeoutMsg: "scrollTop=0 后虚拟化窗口没有对齐到滚动位置（视口内始终没有行）",
    },
  );
}

/** 点「回到底部」按钮（恢复跟随并贴底）。 */
export async function clickV4TimelineBackToBottom() {
  return clickTestIdByDom(TID_V4_TIMELINE_BOTTOM, {
    timeout: 15000,
    timeoutMsg: "v4 回到底部按钮没有出现",
  });
}

// ── TN：v4 对话轮次导航 minimap ──

export interface V4TurnNavigatorState {
  centerOffsetPx: number;
  composerLeftGutterPx: number;
  exists: boolean;
  firstItemLeftOffsetPx: number;
  visible: boolean;
  itemCount: number;
  paneWidthPx: number;
  items: Array<{
    active: boolean;
    height: number;
    left: number;
    testId: string;
    top: number;
    turnId: string | null;
    unitIndex: number | null;
    visualColorTone: string | null;
    visualScale: number | null;
    visualTone: string | null;
  }>;
}

export function getV4TurnNavigatorState(): Promise<V4TurnNavigatorState> {
  return browser.execute(
    (navigatorTestId, itemPrefix, timelineTestId, composerTestId, sessionPaneTestId) => {
      const pane = document.querySelector<HTMLElement>(`[data-testid="${sessionPaneTestId}"]`);
      const scope: Document | HTMLElement = pane ?? document;
      const navigator = scope.querySelector<HTMLElement>(`[data-testid="${navigatorTestId}"]`);
      const timeline = scope.querySelector<HTMLElement>(`[data-testid="${timelineTestId}"]`);
      const composer = scope.querySelector<HTMLElement>(`[data-testid="${composerTestId}"]`);
      const style = navigator ? window.getComputedStyle(navigator) : null;
      const rect = navigator?.getBoundingClientRect();
      const timelineRect = timeline?.getBoundingClientRect();
      const composerRect = composer?.getBoundingClientRect();
      const paneRect = pane?.getBoundingClientRect();
      const items = Array.from(
        navigator?.querySelectorAll<HTMLElement>(`[data-testid^="${itemPrefix}-"]`) ?? [],
      ).map((el) => {
        const itemRect = el.getBoundingClientRect();
        return {
          active: el.getAttribute("data-active") === "true",
          height: itemRect.height,
          left: itemRect.left,
          testId: el.dataset.testid ?? "",
          top: itemRect.top,
          turnId: el.getAttribute("data-turn-id"),
          unitIndex:
            el.getAttribute("data-unit-index") === null
              ? null
              : Number(el.getAttribute("data-unit-index")),
          visualColorTone: el.getAttribute("data-visual-color-tone"),
          visualScale:
            el.getAttribute("data-visual-scale") === null
              ? null
              : Number(el.getAttribute("data-visual-scale")),
          visualTone: el.getAttribute("data-visual-tone"),
        };
      });
      const firstItemLeftOffsetPx =
        items[0] && timelineRect ? items[0].left - timelineRect.left : Number.NaN;
      const firstItem = items[0];
      const lastItem = items.at(-1);
      const stackCenter =
        firstItem && lastItem ? (firstItem.top + lastItem.top + lastItem.height) / 2 : Number.NaN;
      const timelineCenter = timelineRect ? timelineRect.top + timelineRect.height / 2 : Number.NaN;
      return {
        centerOffsetPx: stackCenter - timelineCenter,
        composerLeftGutterPx:
          composerRect && timelineRect ? composerRect.left - timelineRect.left : Number.NaN,
        exists: Boolean(navigator),
        firstItemLeftOffsetPx,
        visible: Boolean(
          navigator &&
          style &&
          rect &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0,
        ),
        itemCount: items.length,
        items,
        paneWidthPx: paneRect?.width ?? Number.NaN,
      };
    },
    TID_V4_TURN_NAVIGATOR,
    TID_V4_TURN_NAVIGATOR_ITEM,
    TID_V4_TIMELINE,
    TID_V4_COMPOSER,
    testId(TID_V4_SESSION_PANE, V4_MAIN_PANE_ID),
  );
}

export async function waitForV4TurnNavigator(
  predicate: (state: V4TurnNavigatorState) => boolean,
  timeoutMsg: string,
  timeout = 30000,
) {
  let latest: V4TurnNavigatorState | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await getV4TurnNavigatorState();
        return predicate(latest);
      },
      { timeout, timeoutMsg },
    );
  } catch (error) {
    latest = await getV4TurnNavigatorState();
    throw new Error(`${timeoutMsg}; latest=${JSON.stringify(latest)}`, {
      cause: error,
    });
  }
  return getV4TurnNavigatorState();
}

async function getV4TurnNavigatorItemTestIdByIndex(index: number) {
  const state = await getV4TurnNavigatorState();
  const item = state.items[index];
  if (!item) {
    throw new Error(
      `v4 turn navigator item 不存在: index=${index}; latest=${JSON.stringify(state)}`,
    );
  }
  return item.testId;
}

export async function hoverV4TurnNavigatorItemByIndex(index: number) {
  const itemTestId = await getV4TurnNavigatorItemTestIdByIndex(index);
  const item = $(sel(itemTestId));
  await item.waitForDisplayed({ timeout: 15000 });
  await item.moveTo();
  return itemTestId;
}

export async function focusV4TurnNavigatorItemByIndex(index: number) {
  const itemTestId = await getV4TurnNavigatorItemTestIdByIndex(index);
  await browser.execute((currentTestId) => {
    document.querySelector<HTMLElement>(`[data-testid="${currentTestId}"]`)?.focus();
  }, itemTestId);
  return itemTestId;
}

export async function clickV4TurnNavigatorItemByIndex(index: number) {
  const itemTestId = await getV4TurnNavigatorItemTestIdByIndex(index);
  await browser.execute((currentTestId) => {
    document.querySelector<HTMLButtonElement>(`[data-testid="${currentTestId}"]`)?.click();
  }, itemTestId);
  return itemTestId;
}

export function getV4TurnNavigatorTooltipText(): Promise<string> {
  return browser.execute((tooltipPrefix) => {
    const tooltip = document.querySelector<HTMLElement>(`[data-testid^="${tooltipPrefix}-"]`);
    return (tooltip?.innerText ?? "").replace(/ /g, " ");
  }, TID_V4_TURN_NAVIGATOR_TOOLTIP);
}

export async function waitForV4TurnNavigatorTooltip(
  predicate: (text: string) => boolean,
  timeoutMsg: string,
  timeout = 15000,
) {
  let latest = "";
  try {
    await browser.waitUntil(
      async () => {
        latest = await getV4TurnNavigatorTooltipText();
        return predicate(latest);
      },
      { timeout, timeoutMsg },
    );
  } catch (error) {
    latest = await getV4TurnNavigatorTooltipText();
    throw new Error(`${timeoutMsg}; latest=${JSON.stringify(latest)}`, {
      cause: error,
    });
  }
  return getV4TurnNavigatorTooltipText();
}

// ── M5⑤ 分屏（Layout/Focus 两层）：pane 级定位与焦点断言 ──
// 分屏后同 testid（composer 输入/发送等）在两个 pane 各有一份，全局 helper 只会
// 命中 DOM 序第一个（primary）。以下 helper 一律先按 v4-pane-shell-<paneId>
// 收口作用域再定位，焦点断言读外壳的 data-focused。

/** 读取当前 focused pane 的 paneId（data-focused="true" 的外壳）；无外壳返回 null。 */
export function getV4FocusedPaneId(): Promise<string | null> {
  return browser.execute((shellPrefix) => {
    const focused = document.querySelector<HTMLElement>(
      `[data-testid^="${shellPrefix}-"][data-focused="true"]`,
    );
    return focused?.getAttribute("data-pane-id") ?? null;
  }, TID_V4_PANE_SHELL);
}

/**
 * 首个非 primary pane 的 paneId（分屏二期 paneId 动态分配：pane-1/pane-2/…，
 * 一期固定 "split" 仅存于 v1 持久化迁移形态）；无分屏返回 null。
 */
export function getV4SecondaryPaneId(): Promise<string | null> {
  return browser.execute(
    (shellPrefix, mainPaneId) => {
      const shells = Array.from(
        document.querySelectorAll<HTMLElement>(`[data-testid^="${shellPrefix}-"]`),
      );
      for (const shell of shells) {
        const paneId = shell.getAttribute("data-pane-id");
        if (paneId && paneId !== mainPaneId) {
          return paneId;
        }
      }
      return null;
    },
    TID_V4_PANE_SHELL,
    V4_MAIN_PANE_ID,
  );
}

/** 当前 workbench 中全部 paneId。 */
export function getV4PaneIds(): Promise<string[]> {
  return browser.execute((shellPrefix) => {
    return Array.from(document.querySelectorAll<HTMLElement>(`[data-testid^="${shellPrefix}-"]`))
      .map((shell) => shell.getAttribute("data-pane-id"))
      .filter((paneId): paneId is string => Boolean(paneId));
  }, TID_V4_PANE_SHELL);
}

/** 是否存在非 primary pane（分屏布局）。 */
export async function hasV4SplitPane(): Promise<boolean> {
  return (await getV4SecondaryPaneId()) !== null;
}

/** 点击 primary pane header 的「向右拆分」按钮，等新 pane 出现并返回其 paneId。 */
export async function openV4SplitPane(): Promise<string> {
  await clickTestIdByDom(TID_V4_SPLIT_OPEN, {
    timeout: 15000,
    timeoutMsg: "v4 拆分按钮没有出现或不可点击",
  });
  let paneId: string | null = null;
  await browser.waitUntil(
    async () => {
      paneId = await getV4SecondaryPaneId();
      return paneId !== null;
    },
    {
      timeout: 15000,
      timeoutMsg: "点击拆分按钮后新 pane 没有出现",
    },
  );
  return paneId as unknown as string;
}

/** 在指定 pane 上点击向右/向下拆分按钮，返回本次新增 paneId。 */
export async function openV4SplitPaneFrom(
  paneId: string,
  direction: "right" | "down" = "right",
): Promise<string> {
  const before = new Set(await getV4PaneIds());
  const splitButtonTestId = direction === "down" ? TID_V4_SPLIT_DOWN : TID_V4_SPLIT_OPEN;
  const clicked = await browser.execute(
    (shellTestId, buttonTestId) => {
      const shell = document.querySelector<HTMLElement>(`[data-testid="${shellTestId}"]`);
      const button = shell?.querySelector<HTMLButtonElement>(`[data-testid="${buttonTestId}"]`);
      if (!button || button.disabled) return false;
      button.click();
      return true;
    },
    testId(TID_V4_PANE_SHELL, paneId),
    splitButtonTestId,
  );
  if (!clicked) {
    throw new Error(`pane ${paneId} 的 ${direction} 拆分按钮不存在或不可用`);
  }

  let addedPaneId: string | null = null;
  await browser.waitUntil(
    async () => {
      const after = await getV4PaneIds();
      addedPaneId = after.find((id) => !before.has(id)) ?? null;
      return addedPaneId !== null;
    },
    {
      timeout: 15000,
      timeoutMsg: `pane ${paneId} 点击 ${direction} 拆分后没有新增 pane`,
    },
  );
  return addedPaneId as unknown as string;
}

/** 点击非 primary pane header 的「关闭窗格」按钮，并等该 pane 外壳消失。 */
export async function closeV4SplitPane() {
  await clickTestIdByDom(TID_V4_SPLIT_CLOSE, {
    timeout: 15000,
    timeoutMsg: "v4 关闭窗格按钮没有出现或不可点击",
  });
  await browser.waitUntil(async () => !(await hasV4SplitPane()), {
    timeout: 15000,
    timeoutMsg: "点击关闭窗格后 pane 没有消失",
  });
}

// ── 布局持久化 / 拖拽调宽 / 侧栏分屏入口 ──

/** paneLayoutStore 的 localStorage 键（packages/ui paneLayoutStore.PANE_LAYOUT_STORAGE_KEY，分屏二期 v2）。 */
export const V4_PANE_LAYOUT_STORAGE_KEY = "zcode-v4-pane-layout:v2";
export const V4_WORKBENCH_GROUP_STORAGE_KEY = "zcode-v4-session-workbench-groups:v1";

/** v2 持久化载荷形态（与 packages/ui paneLayoutStore PersistedPaneLayoutV2 对偶，e2e 断言/篡改用）。 */
export interface V4PersistedPaneLayout {
  root: {
    type: string;
    ratio?: number;
    [key: string]: unknown;
  };
  panes: Record<string, { workspaceScope: { workspacePath: string }; sessionId: string | null }>;
  focusedPaneId: string;
}

/** promoted 分屏的唯一持久化 owner（与 packages/ui workbenchGroupStore 对偶）。 */
export interface V4PersistedWorkbenchGroups {
  activeGroupId: string | null;
  groups: Record<
    string,
    {
      root: {
        type: string;
        ratio?: number;
        [key: string]: unknown;
      };
      panes: Record<
        string,
        {
          workspaceScope: { workspacePath: string };
          sessionId: string;
        }
      >;
      focusedPaneId: string;
    }
  >;
}

/** 读取当前分屏占比（primary 外壳宽 / 容器宽）；无分屏或容器不可测返回 null。 */
export function getV4SplitRatio(): Promise<number | null> {
  return browser.execute(
    (primaryShellTestId, shellPrefix, mainPaneId) => {
      const primary = document.querySelector<HTMLElement>(`[data-testid="${primaryShellTestId}"]`);
      const hasSecondary = Array.from(
        document.querySelectorAll<HTMLElement>(`[data-testid^="${shellPrefix}-"]`),
      ).some((shell) => shell.getAttribute("data-pane-id") !== mainPaneId);
      const container = primary?.parentElement;
      if (!primary || !hasSecondary || !container) return null;
      const containerWidth = container.getBoundingClientRect().width;
      if (containerWidth <= 0) return null;
      return primary.getBoundingClientRect().width / containerWidth;
    },
    testId(TID_V4_PANE_SHELL, V4_MAIN_PANE_ID),
    TID_V4_PANE_SHELL,
    V4_MAIN_PANE_ID,
  );
}

/**
 * 把分屏分隔条拖到容器宽度的 targetRatio 处（pointer events：down → move → up；
 * 分隔条 pointerup 提交 store → 持久化）。
 */
export async function dragV4SplitDividerTo(targetRatio: number) {
  const dispatched = await browser.execute(
    (dividerTestId, primaryShellTestId, ratio) => {
      const divider = document.querySelector<HTMLElement>(`[data-testid="${dividerTestId}"]`);
      const container = document.querySelector<HTMLElement>(
        `[data-testid="${primaryShellTestId}"]`,
      )?.parentElement;
      if (!divider || !container) return false;
      const containerRect = container.getBoundingClientRect();
      const dividerRect = divider.getBoundingClientRect();
      const startX = dividerRect.left + dividerRect.width / 2;
      const y = dividerRect.top + dividerRect.height / 2;
      const targetX = containerRect.left + containerRect.width * ratio;
      const base = {
        bubbles: true,
        cancelable: true,
        button: 0,
        pointerId: 1,
        pointerType: "mouse",
      } as const;
      divider.dispatchEvent(
        new PointerEvent("pointerdown", { ...base, clientX: startX, clientY: y }),
      );
      divider.dispatchEvent(
        new PointerEvent("pointermove", {
          ...base,
          clientX: (startX + targetX) / 2,
          clientY: y,
        }),
      );
      divider.dispatchEvent(
        new PointerEvent("pointermove", { ...base, clientX: targetX, clientY: y }),
      );
      divider.dispatchEvent(
        new PointerEvent("pointerup", { ...base, clientX: targetX, clientY: y }),
      );
      return true;
    },
    TID_V4_SPLIT_DIVIDER,
    testId(TID_V4_PANE_SHELL, V4_MAIN_PANE_ID),
    targetRatio,
  );
  if (!dispatched) {
    throw new Error("分屏分隔条不存在，无法拖拽");
  }
}

/** 等待实际分屏占比进入 target±tolerance。 */
export async function waitForV4SplitRatio(target: number, tolerance = 0.03, timeout = 15000) {
  let latest: number | null = null;
  await browser.waitUntil(
    async () => {
      latest = await getV4SplitRatio();
      return latest !== null && Math.abs(latest - target) <= tolerance;
    },
    {
      timeout,
      timeoutMsg: `分屏占比没有达到 ${target}（最近值 ${latest}）`,
    },
  );
}

/** 右键侧栏会话项 → 上下文菜单「在分屏打开」→ 等新 pane 出现并返回其 paneId（仅桌面 shell）。 */
export async function openV4SplitFromSidebar(sessionId: string): Promise<string> {
  const before = new Set(await getV4PaneIds());
  await browser.waitUntil(
    async () =>
      browser.execute(
        (itemTestId) => {
          const item = document.querySelector<HTMLElement>(`[data-testid="${itemTestId}"]`);
          if (!item) return false;
          const rect = item.getBoundingClientRect();
          item.dispatchEvent(
            new MouseEvent("contextmenu", {
              bubbles: true,
              cancelable: true,
              button: 2,
              clientX: rect.left + rect.width / 2,
              clientY: rect.top + rect.height / 2,
            }),
          );
          return true;
        },
        testId(TID_TASK_ITEM, sessionId),
      ),
    {
      timeout: 15000,
      timeoutMsg: `侧栏会话项不存在: ${sessionId}`,
    },
  );
  await clickTestIdByDom(TID_V4_TASK_OPEN_IN_SPLIT, {
    timeout: 15000,
    timeoutMsg: "会话项上下文菜单「在分屏打开」没有出现",
  });
  let paneId: string | null = null;
  await browser.waitUntil(
    async () => {
      const after = await getV4PaneIds();
      paneId =
        after.find((candidate) => !before.has(candidate)) ??
        (before.size === 1 ? await getV4SecondaryPaneId() : null);
      return paneId !== null;
    },
    {
      timeout: 15000,
      timeoutMsg: "「在分屏打开」后新 pane 没有出现",
    },
  );
  return paneId as unknown as string;
}

/** 点击侧栏会话项并等待 primary pane 绑定到该 session。 */
export async function selectV4TaskById(sessionId: string, taskListTimeout = 15000) {
  await clickTestIdByDom(testId(TID_TASK_ITEM, sessionId), {
    timeout: taskListTimeout,
    timeoutMsg: `任务列表没有可点击的 v4 task: ${sessionId}`,
  });
  await waitForV4Pane(
    (snapshot) => snapshot.sessionId === sessionId,
    `点击侧栏 task 后 primary pane 没有切到 ${sessionId}`,
    30000,
    V4_MAIN_PANE_ID,
  );
}

/** 对 pane 外壳派发 pointerdown（Focus 层 onPointerDownCapture → focus 该 pane）。 */
export async function focusV4Pane(paneId: string) {
  const dispatched = await browser.execute(
    (shellTestId) => {
      const shell = document.querySelector<HTMLElement>(`[data-testid="${shellTestId}"]`);
      if (!shell) return false;
      shell.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
      return true;
    },
    testId(TID_V4_PANE_SHELL, paneId),
  );
  if (!dispatched) {
    throw new Error(`focusV4Pane: pane 外壳不存在: ${paneId}`);
  }
  await browser.waitUntil(async () => (await getV4FocusedPaneId()) === paneId, {
    timeout: 15000,
    timeoutMsg: `pane ${paneId} 没有获得焦点`,
  });
}

/** pane 作用域内点 stop（分屏时全局 TID_V4_STOP 会命中 DOM 序第一个 pane）。 */
export async function clickV4StopInPane(paneId: string) {
  const clicked = await browser.execute(
    (shellTestId, stopTestId) => {
      const shell = document.querySelector<HTMLElement>(`[data-testid="${shellTestId}"]`);
      const btn = shell?.querySelector<HTMLButtonElement>(`[data-testid="${stopTestId}"]`);
      btn?.click();
      return Boolean(btn);
    },
    testId(TID_V4_PANE_SHELL, paneId),
    TID_V4_STOP,
  );
  if (!clicked) {
    throw new Error(`pane ${paneId} 内没有可点击的 stop 按钮`);
  }
}

/** pane 作用域内点分屏 pane 的 session pane snapshot（按 paneId）。 */
export async function waitForV4PaneById(
  paneId: string,
  predicate: (snapshot: V4PaneSnapshot) => boolean,
  timeoutMsg: string,
  timeout = 30000,
) {
  return waitForV4Pane(predicate, timeoutMsg, timeout, paneId);
}

/** pane 作用域内写 composer 文本并点发送（同 sendV4Prompt，但按 paneId 收口）。 */
export async function sendV4PromptInPane(paneId: string, prompt: string) {
  const paneShellTestId = testId(TID_V4_PANE_SHELL, paneId);
  // M5：composer 为 Lexical contenteditable——写入走编辑器挂载的 __zcodeLexicalInputE2E
  // bridge（驱动真实 editor state）；bridge.focus() 同时驱动 Focus 层 → composer 归属该 pane。
  await browser.waitUntil(
    async () =>
      browser.execute(
        (shellTestId, inputTestId, nextValue) => {
          const shell = document.querySelector<HTMLElement>(`[data-testid="${shellTestId}"]`);
          const element = shell?.querySelector<HTMLElement>(`[data-testid="${inputTestId}"]`);
          if (!element) return false;
          const bridge = (
            element as HTMLElement & {
              __zcodeLexicalInputE2E?: {
                focus: () => void;
                getText: () => string;
                setText: (text: string) => void;
              };
            }
          ).__zcodeLexicalInputE2E;
          if (!bridge) return false;
          bridge.focus();
          bridge.setText(nextValue);
          return bridge.getText() === nextValue;
        },
        paneShellTestId,
        TID_V4_COMPOSER_INPUT,
        prompt,
      ),
    {
      timeout: 15000,
      timeoutMsg: `pane ${paneId} 的 composer 输入框没有出现或不可输入`,
    },
  );
  await browser.waitUntil(
    async () =>
      browser.execute(
        (shellTestId, sendTestId) => {
          const shell = document.querySelector<HTMLElement>(`[data-testid="${shellTestId}"]`);
          const button = shell?.querySelector<HTMLButtonElement>(`[data-testid="${sendTestId}"]`);
          if (!button || button.disabled) return false;
          button.click();
          return true;
        },
        paneShellTestId,
        TID_V4_COMPOSER_SEND,
      ),
    {
      timeout: 30000,
      timeoutMsg: `pane ${paneId} 的发送按钮没有变为可用`,
    },
  );
}

/** 等待 v4 权限弹窗出现（V4InteractionDialogs → PermissionDialog，role=listbox）。 */
export function hasV4PermissionDialog(): Promise<boolean> {
  return browser.execute(() => {
    const normalize = (value: string | null | undefined) => (value ?? "").replace(/ /g, " ").trim();
    return Array.from(document.querySelectorAll<HTMLElement>('[role="listbox"]')).some(
      (element) => {
        const label = normalize(element.getAttribute("aria-label"));
        return label === "Permission required" || label === "需要权限";
      },
    );
  });
}

/** V4 普通 permission 声明 freeText 能力时，底部输入行必须实际挂载。 */
export function hasV4PermissionFeedbackInput(): Promise<boolean> {
  return browser.execute(() =>
    Boolean(
      document.querySelector(
        'textarea[aria-label="Optional feedback for the model when denying"],textarea[aria-label="拒绝时给模型的可选反馈"]',
      ),
    ),
  );
}

export async function waitForV4PermissionDialog(timeout = 60000) {
  await browser.waitUntil(hasV4PermissionDialog, { timeout, timeoutMsg: "v4 权限弹窗没有出现" });
}

export interface V4PermissionRuleScope {
  kind: "exact" | "prefix";
  text: string;
}

export async function getV4PermissionRuleScopes(): Promise<V4PermissionRuleScope[]> {
  return browser.execute(() => {
    const normalize = (value: string | null | undefined) => (value ?? "").replace(/ /g, " ").trim();
    const listbox = Array.from(document.querySelectorAll<HTMLElement>('[role="listbox"]')).find(
      (element) => {
        const label = normalize(element.getAttribute("aria-label"));
        return label === "Permission required" || label === "需要权限";
      },
    );
    return Array.from(
      listbox?.querySelectorAll<HTMLElement>("[data-permission-rule-scope]") ?? [],
    ).map((element) => ({
      kind: element.getAttribute("data-permission-rule-scope") === "prefix" ? "prefix" : "exact",
      text: normalize(element.innerText),
    }));
  });
}

export interface V4PermissionDockState {
  inDock: boolean;
  composerMounted: boolean;
  composerHidden: boolean;
  interactionBeforeComposer: boolean;
  composerAriaHidden: string | null;
  composerDisplay: string | null;
}

async function readV4PermissionDockState(): Promise<V4PermissionDockState> {
  return browser.execute((composerTestId) => {
    const normalize = (v: string | null | undefined) => (v ?? "").replace(/ /g, " ").trim();
    const listbox = Array.from(document.querySelectorAll<HTMLElement>('[role="listbox"]')).find(
      (el) => {
        const label = normalize(el.getAttribute("aria-label"));
        return label === "Permission required" || label === "需要权限";
      },
    );
    const dock = listbox?.closest<HTMLElement>('[data-v4-composer-dock="true"]') ?? null;
    const composer = dock?.querySelector<HTMLElement>(`[data-testid="${composerTestId}"]`) ?? null;
    const composerDisplay = composer ? getComputedStyle(composer).display : null;
    const interactionBeforeComposer = Boolean(
      listbox &&
      composer &&
      listbox.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
    return {
      inDock: Boolean(dock),
      composerMounted: Boolean(composer),
      composerHidden:
        composer?.getAttribute("aria-hidden") === "true" && composerDisplay === "none",
      interactionBeforeComposer,
      composerAriaHidden: composer?.getAttribute("aria-hidden") ?? null,
      composerDisplay,
    };
  }, TID_V4_COMPOSER);
}

/**
 * 等待真实权限弹窗进入 v4 composer dock，并确认阻塞期间 composer 只隐藏不卸载。
 */
export async function waitForV4PermissionDialogInComposerDock(timeout = 60000) {
  await waitForV4PermissionDialog(timeout);
  await browser.waitUntil(
    async () => {
      const state = await readV4PermissionDockState();
      return (
        state.inDock &&
        state.composerMounted &&
        state.composerHidden &&
        state.interactionBeforeComposer
      );
    },
    { timeout, timeoutMsg: "v4 权限弹窗没有进入 composer dock 或 composer 未正确隐藏" },
  );
  return readV4PermissionDockState();
}

/**
 * 批准 v4 权限弹窗的第一个选项（Allow once）。PermissionDialog 首项默认选中，
 * 单击已选中项即确认 onRespond → resolveInteraction 命令。为稳妥点两次
 *（第一次若只是选中，第二次确认）。
 */
export async function approveV4Permission(feedback?: string) {
  await waitForV4PermissionDialog();
  if (feedback !== undefined) {
    const input = await $(
      'textarea[aria-label="Optional feedback for the model when denying"],textarea[aria-label="拒绝时给模型的可选反馈"]',
    );
    await input.waitForDisplayed({ timeout: 15000 });
    await input.setValue(feedback);
  }
  const confirmFirstOption = () =>
    browser.execute(() => {
      const normalize = (v: string | null | undefined) => (v ?? "").replace(/ /g, " ").trim();
      const listbox = Array.from(document.querySelectorAll<HTMLElement>('[role="listbox"]')).find(
        (el) => {
          const label = normalize(el.getAttribute("aria-label"));
          return label === "Permission required" || label === "需要权限";
        },
      );
      const option = listbox?.querySelector<HTMLButtonElement>('button[role="option"]');
      option?.click();
      return Boolean(option);
    });
  await confirmFirstOption();
  // 弹窗消失即视为已应答；若首次点击只是选中，再点一次确认。
  const dismissed = await browser
    .waitUntil(
      async () => {
        const stillOpen = await browser.execute(() => {
          const normalize = (v: string | null | undefined) => (v ?? "").replace(/ /g, " ").trim();
          return Array.from(document.querySelectorAll<HTMLElement>('[role="listbox"]')).some(
            (el) => {
              const label = normalize(el.getAttribute("aria-label"));
              return label === "Permission required" || label === "需要权限";
            },
          );
        });
        if (stillOpen) {
          await confirmFirstOption();
          return false;
        }
        return true;
      },
      { timeout: 15000, timeoutMsg: "v4 权限弹窗批准后没有关闭" },
    )
    .then(() => true)
    .catch(() => false);
  return dismissed;
}

/** 填写拒绝反馈并确认 Deny，反馈走同一个 resolveInteraction 应答。 */
export async function denyV4PermissionWithFeedback(feedback: string, submitWithEnter = false) {
  await waitForV4PermissionDialog();
  const input = await $(
    'textarea[aria-label="Optional feedback for the model when denying"],textarea[aria-label="拒绝时给模型的可选反馈"]',
  );
  await input.waitForDisplayed({ timeout: 15000 });
  await input.setValue(feedback);

  // 空白输入行不能提交；普通 Deny 仍可确认且只回传基础拒绝文案。
  if (!feedback.trim() && !submitWithEnter) {
    await browser.execute(() => {
      document
        .querySelector<HTMLButtonElement>('[role="option"][data-permission-option-kind^="reject"]')
        ?.focus();
    });
  }
  await browser.waitUntil(
    () =>
      browser.execute((hasFeedback: boolean) => {
        const selectedDeny = document.querySelector(
          '[role="option"][data-permission-option-kind^="reject"][aria-selected="true"]',
        );
        const input = document.querySelector<HTMLTextAreaElement>(
          'textarea[aria-label="Optional feedback for the model when denying"],textarea[aria-label="拒绝时给模型的可选反馈"]',
        );
        return hasFeedback
          ? !selectedDeny &&
              document.activeElement === input &&
              input?.parentElement?.classList.contains("bg-selected")
          : Boolean(selectedDeny);
      }, Boolean(feedback.trim())),
    { timeout: 5000, timeoutMsg: "权限反馈行与普通 Deny 的独立选择状态不符合预期" },
  );

  if (submitWithEnter) {
    await input.click();
    await browser.keys("Enter");
  }

  const clicked = submitWithEnter
    ? true
    : await browser.execute(() => {
        const normalize = (v: string | null | undefined) => (v ?? "").replace(/ /g, " ").trim();
        const listbox = Array.from(document.querySelectorAll<HTMLElement>('[role="listbox"]')).find(
          (el) => {
            const label = normalize(el.getAttribute("aria-label"));
            return label === "Permission required" || label === "需要权限";
          },
        );
        // 按稳定的阻塞交互区域定位，避免新增视觉分组后依赖 listbox 的直接父节点。
        const confirmButton = listbox
          ?.closest('[data-v4-composer-dock="true"]')
          ?.querySelector<HTMLButtonElement>(
            'button[aria-label="Confirm"],button[aria-label="确认"]',
          );
        confirmButton?.click();
        return Boolean(confirmButton);
      });
  if (!clicked) return false;

  return browser
    .waitUntil(async () => !(await hasV4PermissionDialog()), {
      timeout: 15000,
      timeoutMsg: "v4 权限弹窗拒绝后没有关闭",
    })
    .then(() => true)
    .catch(() => false);
}

/** 选择携带 CLI suggestion 的项目级始终允许选项。 */
export async function approveV4PermissionAlways() {
  await waitForV4PermissionDialog();
  const confirmAlwaysOption = () =>
    browser.execute(() => {
      const normalize = (value: string | null | undefined) =>
        (value ?? "").replace(/ /g, " ").trim();
      const listbox = Array.from(document.querySelectorAll<HTMLElement>('[role="listbox"]')).find(
        (element) => {
          const label = normalize(element.getAttribute("aria-label"));
          return label === "Permission required" || label === "需要权限";
        },
      );
      const option = Array.from(
        listbox?.querySelectorAll<HTMLButtonElement>('button[role="option"]') ?? [],
      ).find((button) => button.dataset.permissionOptionKind === "allowAlways");
      option?.click();
      return Boolean(option);
    });

  if (!(await confirmAlwaysOption())) return false;
  return browser
    .waitUntil(
      async () => {
        const stillOpen = await hasV4PermissionDialog();
        if (stillOpen) {
          await confirmAlwaysOption();
          return false;
        }
        return true;
      },
      { timeout: 15000, timeoutMsg: "v4 项目始终允许后权限弹窗没有关闭" },
    )
    .then(() => true)
    .catch(() => false);
}

// ── M5 composer 工具条 / slash 面板 ──

/** 读取 composer 当前文本（Lexical E2E bridge）。bridge 未挂载返回 null。 */
export function getV4ComposerText(): Promise<string | null> {
  return browser.execute((inputTestId) => {
    const element = document.querySelector<HTMLElement>(`[data-testid="${inputTestId}"]`);
    const bridge = (
      element as (HTMLElement & { __zcodeLexicalInputE2E?: { getText: () => string } }) | null
    )?.__zcodeLexicalInputE2E;
    return bridge ? bridge.getText() : null;
  }, TID_V4_COMPOSER_INPUT);
}

/** composer 本体或其 Lexical 子节点当前是否持有焦点。 */
export function isV4ComposerFocused(): Promise<boolean> {
  return browser.execute((inputTestId) => {
    const element = document.querySelector<HTMLElement>(`[data-testid="${inputTestId}"]`);
    return Boolean(element && document.activeElement && element.contains(document.activeElement));
  }, TID_V4_COMPOSER_INPUT);
}

/** 读取 composer 附件卡片的可观察文件名与 ready 状态。 */
export function getV4ComposerAttachments(): Promise<
  Array<{ text: string; uploadStatus: string | null }>
> {
  return browser.execute(
    (attachmentPrefix) =>
      Array.from(document.querySelectorAll<HTMLElement>(`[data-testid^="${attachmentPrefix}-"]`))
        .filter((element) => element.hasAttribute("data-upload-status"))
        .map((element) => {
          // Bug 原因：媒体卡片按产品设计只展示缩略图，文件名在 img alt 中；读取
          // innerText 会把 ready 的图片误判成“附件没有进入 ready”。
          const mediaFilename = element.querySelector<HTMLImageElement>("img[alt]")?.alt.trim();
          return {
            text: mediaFilename || (element.innerText || element.textContent || "").trim(),
            uploadStatus: element.getAttribute("data-upload-status"),
          };
        }),
    TID_V4_ATTACHMENT,
  );
}

/** slash 候选面板是否出现。 */
export function hasV4SlashPanel(): Promise<boolean> {
  return browser.execute(
    (panelTestId) => Boolean(document.querySelector(`[data-testid="${panelTestId}"]`)),
    TID_PROMPT_SUGGESTION_PANEL,
  );
}

/** 读取 slash 面板当前候选项 id（如 "slash:compact"）。 */
export function getV4SlashOptionIds(): Promise<string[]> {
  return browser.execute((optionPrefix) => {
    return Array.from(
      document.querySelectorAll<HTMLElement>(`[data-testid^="${optionPrefix}-"]`),
    ).map((element) => element.getAttribute("data-option-id") ?? "");
  }, TID_PROMPT_SUGGESTION_OPTION);
}

/** 等待 slash 面板出现且包含目标候选项。 */
export async function waitForV4SlashOption(optionId: string, timeout = 15000) {
  await browser.waitUntil(
    async () => (await hasV4SlashPanel()) && (await getV4SlashOptionIds()).includes(optionId),
    {
      timeout,
      timeoutMsg: `slash 面板没有出现候选项: ${optionId}`,
    },
  );
}

/**
 * 点选 slash 候选项。面板选项在 mousedown 上确认（preventDefault 防 blur），
 * element.click() 不派发 mousedown，这里显式 dispatch。
 */
export async function clickV4SlashOption(optionId: string) {
  const optionTestId = testId(TID_PROMPT_SUGGESTION_OPTION, optionId);
  let dispatched = false;
  await browser.waitUntil(
    async () => {
      // Bug 根因：Windows Skill option id 含反斜杠，动态 CSS selector 无法精确命中；
      // 同时 React 可能在候选加载时重挂载节点，所以定位与 mousedown 必须在一次查询内重试。
      dispatched = await browser.execute(dispatchMouseDownByExactTestId, optionTestId);
      return dispatched;
    },
    {
      timeout: 15000,
      timeoutMsg: `slash 面板候选项不可点击: ${optionId}`,
    },
  );
  return dispatched;
}

/** 通过 composer 工具条切换协作模式（switchCollaborationMode 命令）。 */
export async function switchV4Mode(mode: string) {
  await selectRadixOption(
    TID_CHAT_MODE_SELECT_TRIGGER,
    testId(TID_CHAT_MODE_SELECT_ITEM, mode),
    `v4 模式选择器没有出现目标模式项: ${mode}`,
  );
}

/** 读取 config 投影扩展锚点（data-mode / data-usage-*，M5 additive）。 */
export function getV4ConfigProjection(): Promise<{
  mode: string | null;
  planEnabled: boolean;
  usageUsed: number;
  usageMax: number;
}> {
  return browser.execute((modelTestId) => {
    const el = document.querySelector<HTMLElement>(`[data-testid="${modelTestId}"]`);
    return {
      mode: el?.getAttribute("data-mode") ?? null,
      usageUsed: Number(el?.getAttribute("data-usage-used") || 0),
      planEnabled: el?.getAttribute("data-plan-enabled") === "true",
      usageMax: Number(el?.getAttribute("data-usage-max") || 0),
    };
  }, TID_V4_MODEL_CONFIG);
}

// ── M5 composer mention（@/#/$）/ 附件 ──
// mention 面板与 slash 面板共用 TID_PROMPT_SUGGESTION_PANEL / _OPTION 契约，
// 故读取/点选原语与 slash 同源；option-id 前缀区分（file:/session:/skill:）。

/**
 * 等待 mention 面板出现且含以 prefix 打头的候选项（如 "session:"）。
 * 返回首个命中的完整 option-id。
 */
export async function waitForV4MentionOptionPrefix(
  prefix: string,
  timeout = 15000,
): Promise<string> {
  let matched: string | undefined;
  await browser.waitUntil(
    async () => {
      if (!(await hasV4SlashPanel())) return false;
      matched = (await getV4SlashOptionIds()).find((id) => id.startsWith(prefix));
      return Boolean(matched);
    },
    {
      timeout,
      timeoutMsg: `mention 面板没有出现以 "${prefix}" 打头的候选项`,
    },
  );
  return matched as string;
}

/** 经真实 paste 事件向 v4 composer 加入一个 File，并走既有 eager upload。 */
export async function pasteV4ComposerFileAttachment(
  filename = "e2e-pasted.png",
  options: { base64?: string; mimeType?: string; pngBase64?: string } = {},
): Promise<string> {
  const pasted = await browser.execute(
    (inputTestId, fileName, explicitBase64, explicitPngBase64, explicitMimeType) => {
      const input = document.querySelector<HTMLElement>(`[data-testid="${inputTestId}"]`);
      const editable =
        input?.querySelector<HTMLElement>('[contenteditable="true"]') ??
        (input?.getAttribute("contenteditable") === "true" ? input : null);
      if (!editable) return false;
      // 修复原因：旧 fixture 虽能被 file 识别为 PNG，但 production Jimp 会拒绝其尾部数据；
      // 使用已通过同一解码器验证的 1×1 PNG，避免图片 E2E 在业务读取前退化为占位文本。
      const imageBase64 =
        explicitBase64 ??
        explicitPngBase64 ??
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4AWMAAQAABQABNtCI3QAAAABJRU5ErkJggg==";
      const binary = atob(imageBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      const file = new File([bytes], fileName, { type: explicitMimeType ?? "image/png" });
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      const pasteEvent = new ClipboardEvent("paste", {
        clipboardData: dataTransfer,
        bubbles: true,
        cancelable: true,
      });
      editable.focus();
      editable.dispatchEvent(pasteEvent);
      return true;
    },
    TID_V4_COMPOSER_INPUT,
    filename,
    options.base64,
    options.pngBase64,
    options.mimeType,
  );
  if (!pasted) {
    throw new Error("v4 composer 输入框没有出现，无法派发粘贴事件");
  }
  return filename;
}

/** 向 v4 composer 派发图片文件；保留既有 case 的语义化入口。 */
export function pasteV4ComposerImageAttachment(
  filename = "e2e-pasted.png",
  options: { base64?: string; mimeType?: string; pngBase64?: string } = {},
): Promise<string> {
  return pasteV4ComposerFileAttachment(filename, options);
}

/** 等待某个 user 行渲染出附件簇，返回文件 pill 文本及媒体缩略图的可访问文件名。 */
export async function waitForV4RowAttachments(timeout = 60000): Promise<string> {
  let text = "";
  await browser.waitUntil(
    async () => {
      text = await browser.execute((attachmentsPrefix) => {
        const el = document.querySelector<HTMLElement>(`[data-testid^="${attachmentsPrefix}-"]`);
        if (!el) return "";
        // Bug 原因：已发送媒体只有缩略图，文件名由 img alt 承载，不能用 innerText
        // 是否为空来判断附件簇有没有渲染。
        const visibleText = (el.innerText ?? "").trim();
        const mediaFilenames = Array.from(el.querySelectorAll<HTMLImageElement>("img[alt]"))
          .map((image) => image.alt.trim())
          .filter(Boolean);
        return [visibleText, ...mediaFilenames].filter(Boolean).join("\n");
      }, TID_V4_ROW_ATTACHMENTS);
      return text.trim().length > 0;
    },
    { timeout, timeoutMsg: "user 行没有渲染出附件簇（TID_V4_ROW_ATTACHMENTS）" },
  );
  return text;
}
