import {
  TID_CHAT_ASSISTANT_HISTORY_CONTENT,
  TID_CHAT_ASSISTANT_HISTORY_TRIGGER,
  TID_CHAT_ASSISTANT_MESSAGE,
  TID_CHAT_MESSAGE_EDIT_BUTTON,
  TID_CHAT_MESSAGE_FORK_BUTTON,
  TID_CHAT_TOOL_CALL_BLOCK,
  TID_CHAT_VIEW,
  TID_TOOL_SUMMARY_TRIGGER,
  TID_V4_SESSION_PANE,
} from "@zcode/shared";

export interface ToolCallBlockSnapshot {
  exists: boolean;
  hasEditAction: boolean;
  hasForkAction: boolean;
  status: string | null;
  testId: string;
  text: string;
  toolCallId: string | null;
  toolName: string | null;
}

interface AssistantMessageSnapshot {
  messageId: string | null;
  text: string;
}

interface ChatStateSnapshot {
  activeInputId: string | null;
  queueCount: string | null;
  state: string | null;
}

export interface ToolCallDiagnostics {
  assistantMessages: AssistantMessageSnapshot[];
  assistantHistory: AssistantHistoryStateSnapshot[];
  blocks: ToolCallBlockSnapshot[];
  chatState: ChatStateSnapshot | null;
  matcher: ToolCallMatcher | null;
  matchedBlock: ToolCallBlockSnapshot | null;
  rendererStore: RendererStoreDiagnostics;
}

interface AssistantHistoryStateSnapshot {
  contentExists: boolean;
  contentOpen: string | null;
  contentText: string;
  expanded: boolean;
  hasContent: string | null;
  stateKey: string | null;
  triggerTestId: string;
}

interface RendererStoreDiagnostics {
  activeTaskId: string | null;
  available: boolean;
  messages: RendererStoreMessageSnapshot[];
  reason: string | null;
}

interface RendererStoreMessageSnapshot {
  content: string;
  id: string | null;
  partTypes: string[];
  role: string | null;
  taskId: string;
  toolCalls: RendererStoreToolCallSnapshot[];
  workspaceKey: string;
}

interface RendererStoreToolCallSnapshot {
  error: string | null;
  output: string | null;
  rawErrorDetail: string | null;
  rawErrorMessage: string | null;
  status: string | null;
  toolId: string | null;
  toolName: string | null;
}

export type ToolCallMatcher =
  | {
      type: "text";
      value: string;
    }
  | {
      type: "toolCallId";
      value: string;
    }
  | {
      type: "toolName";
      value: string;
    };

export function expandAssistantHistoriesWithContent(): Promise<void> {
  return browser.execute((historyTriggerPrefix) => {
    const triggers = Array.from(
      document.querySelectorAll<HTMLElement>(
        `[data-testid^="${historyTriggerPrefix}-"]`,
      ),
    );
    for (const trigger of triggers) {
      const expanded =
        trigger.getAttribute("aria-expanded") === "true" ||
        trigger.getAttribute("data-history-open") === "true";
      if (
        trigger.getAttribute("data-history-has-content") !== "false" &&
        !expanded
      ) {
        trigger.click();
      }
    }
  }, TID_CHAT_ASSISTANT_HISTORY_TRIGGER);
}

/**
 * 展开当前已渲染的工具分组，令按原始 tool call id 的断言可以观察到 child。
 *
 * V4 会把连续的 Bash/terminal 调用折叠进 ExecuteGroup，父节点刻意只锚定
 * 首个 child 的 id 以避免流式新增时重建。若等待器只扫描折叠态 DOM，第二个
 * child 会被误判为未渲染，进而把分组 UI 的正常行为报告成 E2E 失败。
 */
export function expandVisibleToolCallGroups(): Promise<void> {
  return browser.execute((summaryTriggerPrefix) => {
    const groupNames = new Set(["Explore", "ExecuteGroup", "ChangesGroup"]);
    const groups = Array.from(
      document.querySelectorAll<HTMLElement>("[data-tool-call-id][data-tool-name]"),
    ).filter((group) => groupNames.has(group.dataset.toolName ?? ""));
    for (const group of groups) {
      const trigger = group.querySelector<HTMLElement>(
        `[data-testid^="${summaryTriggerPrefix}-"]`,
      );
      if (trigger?.getAttribute("aria-expanded") !== "true") {
        trigger?.click();
      }
    }
  }, TID_TOOL_SUMMARY_TRIGGER);
}

export function getToolCallDiagnostics(
  matcher: ToolCallMatcher | null,
): Promise<ToolCallDiagnostics> {
  return browser.execute(
    (
      toolBlockPrefix,
      editButtonPrefix,
      forkButtonPrefix,
      assistantMessagePrefix,
      chatViewTestId,
      historyTriggerPrefix,
      historyContentPrefix,
      v4PaneTestId,
      expectedMatcher,
    ) => {
      const normalizeText = (value: string) =>
        value.replace(/\u00a0/g, " ").trim();
      const blocks = Array.from(
        document.querySelectorAll<HTMLElement>(
          `[data-testid^="${toolBlockPrefix}-"]`,
        ),
      ).map((block) => ({
        exists: true,
        hasEditAction: Boolean(
          block.querySelector(`[data-testid^="${editButtonPrefix}-"]`),
        ),
        hasForkAction: Boolean(
          block.querySelector(`[data-testid^="${forkButtonPrefix}-"]`),
        ),
        status: block.getAttribute("data-status"),
        testId: block.getAttribute("data-testid") ?? "",
        text: normalizeText(block.innerText),
        toolCallId: block.getAttribute("data-tool-call-id"),
        toolName: block.getAttribute("data-tool-name"),
      }));

      const matchedBlock =
        expectedMatcher === null
          ? null
          : (blocks.findLast((block) => {
              if (expectedMatcher.type === "text") {
                return block.text.includes(expectedMatcher.value);
              }
              if (expectedMatcher.type === "toolCallId") {
                return (
                  block.toolCallId === expectedMatcher.value ||
                  block.toolCallId?.startsWith(`${expectedMatcher.value}:`) ||
                  // 现行 V4 会把连续 Bash 收拢到 ExecuteGroup；父组稳定地以首个真实
                  // tool call id 作为 identity。折叠态不会渲染 child DOM，诊断必须在
                  // 此处识别这个可追溯的投影，而不是要求 UI 恢复旧的平铺结构。
                  block.toolCallId === `execute:${expectedMatcher.value}`
                );
              }
              return (
                block.toolName === expectedMatcher.value ||
                (expectedMatcher.value === "Bash" &&
                  block.toolName === "ExecuteGroup")
              );
            }) ?? null);

      const assistantMessages = Array.from(
        document.querySelectorAll<HTMLElement>(
          `[data-testid^="${assistantMessagePrefix}-"]`,
        ),
      ).map((message) => ({
        messageId: message.getAttribute("data-message-id"),
        text: normalizeText(message.innerText),
      }));
      const assistantHistory = Array.from(
        document.querySelectorAll<HTMLElement>(
          `[data-testid^="${historyTriggerPrefix}-"]`,
        ),
      ).map((trigger) => {
        const triggerTestId = trigger.getAttribute("data-testid") ?? "";
        // Bug 根因：V4 history 只把 unit.key 编入 test id，不再写
        // data-history-state-key；旧诊断因此找不到已存在的折叠内容，误导 E2E 归因。
        const stateKey =
          trigger.getAttribute("data-history-state-key") ??
          (triggerTestId.startsWith(`${historyTriggerPrefix}-`)
            ? triggerTestId.slice(historyTriggerPrefix.length + 1)
            : null);
        const content =
          stateKey !== null
            ? Array.from(
                document.querySelectorAll<HTMLElement>(
                  `[data-testid^="${historyContentPrefix}-"]`,
                ),
              ).find(
                (candidate) =>
                  candidate.getAttribute("data-testid") ===
                  `${historyContentPrefix}-${stateKey}`,
              ) ?? null
            : null;
        return {
          contentExists: Boolean(content),
          contentOpen: content?.getAttribute("data-history-open") ?? null,
          contentText: normalizeText(content?.innerText ?? ""),
          expanded: trigger.getAttribute("aria-expanded") === "true",
          hasContent: trigger.getAttribute("data-history-has-content"),
          stateKey,
          triggerTestId,
        };
      });

      const chatView = document.querySelector<HTMLElement>(
        `[data-testid="${chatViewTestId}"]`,
      );
      const chatState = chatView
        ? {
            activeInputId: chatView.getAttribute("data-active-input-id"),
            queueCount: chatView.getAttribute("data-queue-count"),
            state: chatView.getAttribute("data-chat-state"),
          }
        : null;
      const v4SessionId = document
        // Bug 根因：V4 pane test id 始终带 paneId 后缀；精确匹配基础 id 会让
        // hooks/tool 失败诊断把真实 active task 误报成 null。
        .querySelector<HTMLElement>(`[data-testid^="${v4PaneTestId}-"]`)
        ?.getAttribute("data-session-id");
      // 修复原因：V4 不再渲染 chat-view；诊断若只从旧 root 取 taskId，
      // 会把 renderer store 误报为空，掩盖真正的 tool 投影问题。
      const activeTaskId =
        chatView?.getAttribute("data-task-id") ||
        (v4SessionId && v4SessionId !== "draft" ? v4SessionId : null);
      const e2eWindow = window as Window & {
        __zcodeSessionStoreE2E?: {
          getState: () => {
            workspaces?: Record<
              string,
              {
                taskMessagesByTaskId?: Record<
                  string,
                  RendererStoreRawMessage[]
                >;
              }
            >;
          };
        };
      };
      const storeApi = e2eWindow.__zcodeSessionStoreE2E;
      const rendererStore = (() => {
        if (!storeApi) {
          return {
            activeTaskId,
            available: false,
            messages: [],
            reason: "store-bridge-missing",
          };
        }

        const state = storeApi.getState();
        const readRecord = (value: unknown): Record<string, unknown> | null =>
          value && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : null;
        const readString = (value: unknown): string | null =>
          typeof value === "string" ? value : null;
        const readRawToolError = (toolCall: RendererStoreRawToolCall) => {
          const raw = readRecord(toolCall.raw);
          const result = readRecord(raw?.result);
          const error = readRecord(raw?.error) ?? readRecord(result?.error);
          return {
            rawErrorDetail: readString(error?.detail),
            rawErrorMessage: readString(error?.message),
          };
        };
        const messages = Object.entries(state.workspaces ?? {}).flatMap(
          ([workspaceKey, workspace]) =>
            Object.entries(workspace.taskMessagesByTaskId ?? {}).flatMap(
              ([taskId, taskMessages]) =>
                taskMessages.map((message) => ({
                  content: message.content ?? "",
                  id: message.id ?? null,
                  partTypes: (message.parts ?? []).map(
                    (part) => part.type ?? "",
                  ),
                  role: message.role ?? null,
                  taskId,
                  toolCalls: (message.toolCalls ?? []).map((toolCall) => {
                    const rawError = readRawToolError(toolCall);
                    return {
                      error: toolCall.error ?? null,
                      output: toolCall.output ?? null,
                      rawErrorDetail: rawError.rawErrorDetail,
                      rawErrorMessage: rawError.rawErrorMessage,
                      status: toolCall.status ?? null,
                      toolId: toolCall.toolId ?? null,
                      toolName: toolCall.toolName ?? null,
                    };
                  }),
                  workspaceKey,
                })),
            ),
        );
        return {
          activeTaskId,
          available: true,
          messages: activeTaskId
            ? messages.filter((message) => message.taskId === activeTaskId)
            : messages,
          reason: null,
        };
      })();

      return {
        assistantMessages,
        assistantHistory,
        blocks,
        chatState,
        matcher: expectedMatcher,
        matchedBlock,
        rendererStore,
      };
    },
    TID_CHAT_TOOL_CALL_BLOCK,
    TID_CHAT_MESSAGE_EDIT_BUTTON,
    TID_CHAT_MESSAGE_FORK_BUTTON,
    TID_CHAT_ASSISTANT_MESSAGE,
    TID_CHAT_VIEW,
    TID_CHAT_ASSISTANT_HISTORY_TRIGGER,
    TID_CHAT_ASSISTANT_HISTORY_CONTENT,
    TID_V4_SESSION_PANE,
    matcher,
  );
}

interface RendererStoreRawMessage {
  content?: string;
  id?: string;
  parts?: Array<{ type?: string }>;
  role?: string;
  toolCalls?: RendererStoreRawToolCall[];
}

interface RendererStoreRawToolCall {
  error?: string | null;
  output?: string | null;
  raw?: unknown;
  status?: string;
  toolId?: string;
  toolName?: string;
}
