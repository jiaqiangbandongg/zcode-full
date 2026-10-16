import {
  TID_CHAT_ASSISTANT_HISTORY_CONTENT,
  TID_CHAT_ASSISTANT_MESSAGE,
  TID_CHAT_INPUT,
  TID_CHAT_MESSAGES,
  TID_CHAT_COMPACT_MARKER,
  TID_CHAT_USER_MESSAGE,
  TID_CHAT_VIEW,
} from "@zcode/shared";

export interface CompactMarkerSnapshot {
  attempt: number | null;
  inputId: string | null;
  inAssistantHistory: boolean;
  maxAttempts: number | null;
  operationId: string | null;
  phase: string | null;
  status: string | null;
  testId: string | null;
  text: string;
  trigger: string | null;
}

export type CompactMarkerStatus =
  | "started"
  | "retrying"
  | "completed"
  | "failed"
  | "interrupted"
  | "skipped";

export async function waitForCompactMarkerStatus(
  status: CompactMarkerStatus,
  trigger: "manual" | "auto" = "manual",
  inputId?: string | null,
  timeout?: number,
): Promise<CompactMarkerSnapshot> {
  return waitForCompactMarkerStatuses([status], trigger, inputId, timeout);
}

export async function waitForCompactMarkerStatuses(
  statuses: readonly CompactMarkerStatus[],
  trigger: "manual" | "auto" = "manual",
  inputId?: string | null,
  timeout?: number,
): Promise<CompactMarkerSnapshot> {
  const statusSet = new Set(statuses);
  let latestMarkers: CompactMarkerSnapshot[] = [];
  try {
    await browser.waitUntil(
      async () => {
        latestMarkers = await getCompactMarkers();
        return latestMarkers.some(
          (marker) =>
            statusSet.has(marker.status as CompactMarkerStatus) &&
            marker.trigger === trigger &&
            (!inputId || marker.inputId === inputId),
        );
      },
      {
        timeout: timeout ?? (statusSet.has("started") ? 20000 : 90000),
        timeoutMsg: `没有等到 compact marker statuses=${statuses.join(
          ",",
        )}, trigger=${trigger}`,
      },
    );
  } catch (error) {
    // 修复原因：WebdriverIO 的 timeoutMsg 在 waitUntil 开始时就固定，不能直接把
    // latestMarkers 放进 timeoutMsg；失败后重新采集 DOM，才能判断命令是否被当普通文本发送。
    const diagnostics = await getCompactMarkerDiagnostics().catch((diagnosticsError) => ({
      error:
        diagnosticsError instanceof Error
          ? diagnosticsError.message
          : String(diagnosticsError),
    }));
    throw new Error(
      `没有等到 compact marker statuses=${statuses.join(
        ",",
      )}, trigger=${trigger}, latest=${JSON.stringify(
        latestMarkers,
      )}, diagnostics=${JSON.stringify(diagnostics)}`,
      { cause: error },
    );
  }

  const marker = latestMarkers.find(
    (candidate) =>
      statusSet.has(candidate.status as CompactMarkerStatus) &&
      candidate.trigger === trigger &&
      (!inputId || candidate.inputId === inputId),
  );
  if (!marker) {
    throw new Error(`compact marker statuses=${statuses.join(",")} 在等待完成后仍不存在`);
  }
  return marker;
}

function getCompactMarkerDiagnostics() {
  return browser.execute(
    (
      compactMarkerPrefix,
      chatViewTestId,
      chatMessagesTestId,
      userMessagePrefix,
      assistantMessagePrefix,
      inputTestId,
      historyContentPrefix,
    ) => {
      const mapV4CompactStatus = (value: string | null) => {
        switch (value) {
          case "running":
            return "started";
          case "success":
            return "completed";
          case "cancelled":
            return "interrupted";
          case "noop":
            return "skipped";
          default:
            return value;
        }
      };
      const legacyCompactMarkers = Array.from(
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
      const v4CompactMarkers = Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-row-kind="timelineMarker"][data-marker-type="compact"]',
        ),
      ).map((element) => ({
        inputId: element.getAttribute("data-source-command-id"),
        operationId: null,
        status: mapV4CompactStatus(element.getAttribute("data-status")),
        testId: element.getAttribute("data-testid"),
        text: element.innerText.trim(),
        trigger: element.getAttribute("data-origin"),
      }));
      const chatRoot = document.querySelector<HTMLElement>(
        `[data-testid="${chatViewTestId}"]`,
      );
      const rawQueueCount = chatRoot?.getAttribute("data-queue-count");
      const messagesRoot = document.querySelector<HTMLElement>(
        `[data-testid="${chatMessagesTestId}"]`,
      );
      const messages = Array.from(
        messagesRoot?.querySelectorAll<HTMLElement>(
          `[data-testid^="${userMessagePrefix}-"],[data-testid^="${assistantMessagePrefix}-"]`,
        ) ?? [],
      ).map((element) => ({
        id: element.getAttribute("data-message-id"),
        role: element.getAttribute("data-role"),
        text: element.innerText.replace(/\u00a0/g, " ").trim(),
        testId: element.getAttribute("data-testid"),
      }));
      const input = document.querySelector<
        HTMLElement & {
          __zcodeLexicalInputE2E?: { getText?: () => string };
        }
      >(`[data-testid="${inputTestId}"]`);

      return {
        chat: {
          activeInputId: chatRoot?.getAttribute("data-active-input-id") || null,
          queueCount: rawQueueCount ? Number(rawQueueCount) : 0,
          runtimeStatus: chatRoot?.getAttribute("data-runtime-status") || null,
          sessionId: chatRoot?.getAttribute("data-session-id") || null,
          state: chatRoot?.getAttribute("data-state") || null,
          stopRequested: chatRoot?.getAttribute("data-stop-requested") === "true",
          taskId: chatRoot?.getAttribute("data-task-id") || null,
        },
        compactMarkers: [...legacyCompactMarkers, ...v4CompactMarkers],
        composer: {
          bridgeText: input?.__zcodeLexicalInputE2E?.getText?.() ?? null,
          domText: (input?.innerText || input?.textContent || "")
            .replace(/\u00a0/g, " ")
            .trim(),
        },
        historyMarkerCount: document.querySelectorAll(
          `[data-testid^="${historyContentPrefix}-"] [data-testid^="${compactMarkerPrefix}-"]`,
        ).length,
        messages: messages.slice(-8),
      };
    },
    TID_CHAT_COMPACT_MARKER,
    TID_CHAT_VIEW,
    TID_CHAT_MESSAGES,
    TID_CHAT_USER_MESSAGE,
    TID_CHAT_ASSISTANT_MESSAGE,
    TID_CHAT_INPUT,
    TID_CHAT_ASSISTANT_HISTORY_CONTENT,
  );
}

export function getCompactMarkers(): Promise<CompactMarkerSnapshot[]> {
  return browser.execute((compactMarkerPrefix, historyContentPrefix) => {
    const mapV4CompactStatus = (value: string | null) => {
      switch (value) {
        case "running":
          return "started";
        case "success":
          return "completed";
        case "cancelled":
          return "interrupted";
        case "noop":
          return "skipped";
        default:
          return value;
      }
    };
    const numberAttribute = (value: string | null): number | null => {
      if (!value) {
        return null;
      }
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    };
    const legacyMarkers = Array.from(
      document.querySelectorAll<HTMLElement>(
        `[data-testid^="${compactMarkerPrefix}-"]`,
      ),
    ).map((element) => ({
      attempt: numberAttribute(element.getAttribute("data-attempt")),
      inputId: element.getAttribute("data-input-id"),
      inAssistantHistory: Boolean(
        element.closest(`[data-testid^="${historyContentPrefix}-"]`),
      ),
      maxAttempts: numberAttribute(element.getAttribute("data-max-attempts")),
      operationId: element.getAttribute("data-operation-id"),
      phase: element.getAttribute("data-phase"),
      status: element.getAttribute("data-status"),
      testId: element.getAttribute("data-testid"),
      text: element.innerText.trim(),
      trigger: element.getAttribute("data-trigger"),
    }));
    const v4Markers = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-row-kind="timelineMarker"][data-marker-type="compact"]',
      ),
    ).map((element) => ({
      attempt: null,
      inputId: element.getAttribute("data-source-command-id"),
      inAssistantHistory: false,
      maxAttempts: null,
      operationId: null,
      phase: null,
      // Bug 根因：V4 timeline 使用 running/success/cancelled/noop，而旧 helper
      // 只识别 started/completed/interrupted/skipped，导致真实 marker 被误报为不存在。
      status: mapV4CompactStatus(element.getAttribute("data-status")),
      testId: element.getAttribute("data-testid"),
      text: element.innerText.trim(),
      trigger: element.getAttribute("data-origin"),
    }));
    return [...legacyMarkers, ...v4Markers];
  }, TID_CHAT_COMPACT_MARKER, TID_CHAT_ASSISTANT_HISTORY_CONTENT);
}
