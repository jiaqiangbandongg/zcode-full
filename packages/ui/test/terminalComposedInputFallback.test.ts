import { describe, expect, it } from "vitest";
import {
  consumeTerminalInputFallbackHandledData,
  createPendingTerminalInputFallback,
  createTerminalInputFallbackKeydownCandidate,
  markTerminalInputFallbackHandled,
  recordTerminalInputFallbackHandledData,
  recordTerminalInputFallbackRecentData,
  resolveTerminalInputFallbackAction,
} from "@/terminal/terminalComposedInputFallback.js";

const MAX_HISTORY_AGE_MS = 150;
const MAX_KEYDOWN_INPUT_DELAY_MS = 40;

function recordKeydownHandledData(params: {
  data: string;
  eventTimeStamp?: number;
  key?: string;
  now?: number;
}) {
  const now = params.now ?? 1000;
  const candidate = createTerminalInputFallbackKeydownCandidate({
    eventTimeStamp: params.eventTimeStamp ?? now,
    key: params.key ?? params.data,
    now,
  });

  return recordTerminalInputFallbackHandledData({
    candidate,
    data: params.data,
    history: [],
    maxAgeMs: MAX_HISTORY_AGE_MS,
    now,
  }).history;
}

describe("terminal composed input fallback", () => {
  it("does not flush a composed space that xterm already emitted through onData", () => {
    const pending = createPendingTerminalInputFallback(" ");

    markTerminalInputFallbackHandled([pending], " ");

    expect(
      resolveTerminalInputFallbackAction({
        pending,
        textareaValue: " ",
      }),
    ).toEqual({
      shouldClearTextarea: true,
      shouldWrite: false,
    });
  });

  it("does not flush when xterm emitted the same space for the same keydown before input", () => {
    const history = recordKeydownHandledData({ data: " ", eventTimeStamp: 1000, now: 1001 });
    const pending = createPendingTerminalInputFallback(" ");

    consumeTerminalInputFallbackHandledData({
      history,
      inputEventTimeStamp: 1002,
      maxAgeMs: MAX_HISTORY_AGE_MS,
      maxInputDelayMs: MAX_KEYDOWN_INPUT_DELAY_MS,
      now: 1002,
      pending,
    });

    expect(
      resolveTerminalInputFallbackAction({
        pending,
        textareaValue: " ",
      }),
    ).toEqual({
      shouldClearTextarea: true,
      shouldWrite: false,
    });
  });

  it("does not flush when a Windows IME commit key already emitted composed text through xterm", () => {
    const recorded = recordTerminalInputFallbackHandledData({
      candidate: createTerminalInputFallbackKeydownCandidate({
        eventTimeStamp: 1000,
        key: "Enter",
        now: 1000,
      }),
      data: "中文",
      history: [],
      maxAgeMs: MAX_HISTORY_AGE_MS,
      now: 1001,
    });
    const pending = createPendingTerminalInputFallback("中文");

    consumeTerminalInputFallbackHandledData({
      history: recorded.history,
      inputEventTimeStamp: 1002,
      maxAgeMs: MAX_HISTORY_AGE_MS,
      maxInputDelayMs: MAX_KEYDOWN_INPUT_DELAY_MS,
      now: 1002,
      pending,
    });

    expect(recorded.usedCandidate).toBe(true);
    expect(resolveTerminalInputFallbackAction({ pending, textareaValue: "中文" })).toEqual({
      shouldClearTextarea: true,
      shouldWrite: false,
    });
  });

  it("does not record Enter control data as a composed input fallback match", () => {
    const recorded = recordTerminalInputFallbackHandledData({
      candidate: createTerminalInputFallbackKeydownCandidate({
        eventTimeStamp: 1000,
        key: "Enter",
        now: 1000,
      }),
      data: "\r",
      history: [],
      maxAgeMs: MAX_HISTORY_AGE_MS,
      now: 1001,
    });
    const pending = createPendingTerminalInputFallback("中文");

    consumeTerminalInputFallbackHandledData({
      history: recorded.history,
      inputEventTimeStamp: 1002,
      maxAgeMs: MAX_HISTORY_AGE_MS,
      maxInputDelayMs: MAX_KEYDOWN_INPUT_DELAY_MS,
      now: 1002,
      pending,
    });

    expect(recorded).toEqual({
      history: [],
      usedCandidate: false,
    });
    expect(resolveTerminalInputFallbackAction({ pending, textareaValue: "中文" })).toEqual({
      shouldClearTextarea: true,
      shouldWrite: true,
    });
  });

  it("deduplicates IME commit data when xterm combines composed text and Enter control data", () => {
    const recorded = recordTerminalInputFallbackHandledData({
      candidate: createTerminalInputFallbackKeydownCandidate({
        eventTimeStamp: 1000,
        key: "Enter",
        now: 1000,
      }),
      data: "中文\r",
      history: [],
      maxAgeMs: MAX_HISTORY_AGE_MS,
      now: 1001,
    });
    const pending = createPendingTerminalInputFallback("中文");

    consumeTerminalInputFallbackHandledData({
      history: recorded.history,
      inputEventTimeStamp: 1080,
      maxAgeMs: MAX_HISTORY_AGE_MS,
      maxInputDelayMs: MAX_KEYDOWN_INPUT_DELAY_MS,
      now: 1080,
      pending,
    });

    expect(recorded.usedCandidate).toBe(true);
    expect(resolveTerminalInputFallbackAction({ pending, textareaValue: "中文" })).toEqual({
      shouldClearTextarea: true,
      shouldWrite: false,
    });
  });

  it("flushes when matching text belongs to an older input event inside the history window", () => {
    const history = recordKeydownHandledData({ data: " ", eventTimeStamp: 1000, now: 1001 });
    const pending = createPendingTerminalInputFallback(" ");

    consumeTerminalInputFallbackHandledData({
      history,
      inputEventTimeStamp: 1100,
      maxAgeMs: MAX_HISTORY_AGE_MS,
      maxInputDelayMs: MAX_KEYDOWN_INPUT_DELAY_MS,
      now: 1100,
      pending,
    });

    expect(
      resolveTerminalInputFallbackAction({
        pending,
        textareaValue: " ",
      }),
    ).toEqual({
      shouldClearTextarea: true,
      shouldWrite: true,
    });
  });

  it("consumes handled keydown data only once", () => {
    const history = recordKeydownHandledData({ data: " ", eventTimeStamp: 1000, now: 1001 });
    const first = createPendingTerminalInputFallback(" ");
    const second = createPendingTerminalInputFallback(" ");

    consumeTerminalInputFallbackHandledData({
      history,
      inputEventTimeStamp: 1002,
      maxAgeMs: MAX_HISTORY_AGE_MS,
      maxInputDelayMs: MAX_KEYDOWN_INPUT_DELAY_MS,
      now: 1002,
      pending: first,
    });
    consumeTerminalInputFallbackHandledData({
      history,
      inputEventTimeStamp: 1003,
      maxAgeMs: MAX_HISTORY_AGE_MS,
      maxInputDelayMs: MAX_KEYDOWN_INPUT_DELAY_MS,
      now: 1003,
      pending: second,
    });

    expect(resolveTerminalInputFallbackAction({ pending: first, textareaValue: " " })).toEqual({
      shouldClearTextarea: true,
      shouldWrite: false,
    });
    expect(resolveTerminalInputFallbackAction({ pending: second, textareaValue: " " })).toEqual({
      shouldClearTextarea: true,
      shouldWrite: true,
    });
  });

  it("does not record consumable history without a matching keydown candidate", () => {
    const recorded = recordTerminalInputFallbackHandledData({
      candidate: null,
      data: " ",
      history: [],
      maxAgeMs: MAX_HISTORY_AGE_MS,
      now: 1001,
    });
    const pending = createPendingTerminalInputFallback(" ");

    consumeTerminalInputFallbackHandledData({
      history: recorded.history,
      inputEventTimeStamp: 1002,
      maxAgeMs: MAX_HISTORY_AGE_MS,
      maxInputDelayMs: MAX_KEYDOWN_INPUT_DELAY_MS,
      now: 1002,
      pending,
    });

    expect(recorded).toEqual({
      history: [],
      usedCandidate: false,
    });
    expect(resolveTerminalInputFallbackAction({ pending, textareaValue: " " })).toEqual({
      shouldClearTextarea: true,
      shouldWrite: true,
    });
  });

  it("does not flush when xterm emitted the same text immediately before composed input", () => {
    const history = recordTerminalInputFallbackRecentData({
      data: "中文",
      history: [],
      maxAgeMs: MAX_HISTORY_AGE_MS,
      now: 1000,
    });
    const pending = createPendingTerminalInputFallback("中文");

    consumeTerminalInputFallbackHandledData({
      history,
      inputEventTimeStamp: 1002,
      maxAgeMs: MAX_HISTORY_AGE_MS,
      maxInputDelayMs: MAX_KEYDOWN_INPUT_DELAY_MS,
      now: 1002,
      pending,
    });

    expect(resolveTerminalInputFallbackAction({ pending, textareaValue: "中文" })).toEqual({
      shouldClearTextarea: true,
      shouldWrite: false,
    });
  });

  it("does not consume anonymous recent data after the immediate input window", () => {
    const history = recordTerminalInputFallbackRecentData({
      data: "中文",
      history: [],
      maxAgeMs: MAX_HISTORY_AGE_MS,
      now: 1000,
    });
    const pending = createPendingTerminalInputFallback("中文");

    consumeTerminalInputFallbackHandledData({
      history,
      inputEventTimeStamp: 1080,
      maxAgeMs: MAX_HISTORY_AGE_MS,
      maxInputDelayMs: MAX_KEYDOWN_INPUT_DELAY_MS,
      now: 1080,
      pending,
    });

    expect(resolveTerminalInputFallbackAction({ pending, textareaValue: "中文" })).toEqual({
      shouldClearTextarea: true,
      shouldWrite: true,
    });
  });

  it("ignores stale xterm data when deciding whether to flush a fallback", () => {
    const history = recordKeydownHandledData({ data: "中", eventTimeStamp: 1000, now: 1001 });
    const pending = createPendingTerminalInputFallback("中");

    consumeTerminalInputFallbackHandledData({
      history,
      inputEventTimeStamp: 1200,
      maxAgeMs: MAX_HISTORY_AGE_MS,
      maxInputDelayMs: MAX_KEYDOWN_INPUT_DELAY_MS,
      now: 1200,
      pending,
    });

    expect(resolveTerminalInputFallbackAction({ pending, textareaValue: "中" })).toEqual({
      shouldClearTextarea: true,
      shouldWrite: true,
    });
  });

  it("does not match fallback input across unrelated recent xterm data chunks", () => {
    const firstHistory = recordKeydownHandledData({
      data: "[",
      eventTimeStamp: 1000,
      now: 1001,
    });
    const history = recordTerminalInputFallbackHandledData({
      candidate: createTerminalInputFallbackKeydownCandidate({
        eventTimeStamp: 1002,
        key: "D",
        now: 1002,
      }),
      data: "D",
      history: firstHistory,
      maxAgeMs: MAX_HISTORY_AGE_MS,
      now: 1003,
    }).history;
    const pending = createPendingTerminalInputFallback("[D");

    consumeTerminalInputFallbackHandledData({
      history,
      inputEventTimeStamp: 1004,
      maxAgeMs: MAX_HISTORY_AGE_MS,
      maxInputDelayMs: MAX_KEYDOWN_INPUT_DELAY_MS,
      now: 1004,
      pending,
    });

    expect(resolveTerminalInputFallbackAction({ pending, textareaValue: "[D" })).toEqual({
      shouldClearTextarea: true,
      shouldWrite: true,
    });
  });

  it("does not match fallback input inside a control sequence emitted by xterm", () => {
    const pending = createPendingTerminalInputFallback("[");

    markTerminalInputFallbackHandled([pending], "\u001b[D");

    expect(resolveTerminalInputFallbackAction({ pending, textareaValue: "[" })).toEqual({
      shouldClearTextarea: true,
      shouldWrite: true,
    });
  });

  it("marks repeated pending spaces when xterm emits them as a combined data chunk", () => {
    const first = createPendingTerminalInputFallback(" ");
    const second = createPendingTerminalInputFallback(" ");

    markTerminalInputFallbackHandled([first, second], "  ");

    expect(resolveTerminalInputFallbackAction({ pending: first, textareaValue: "  " })).toEqual({
      shouldClearTextarea: true,
      shouldWrite: false,
    });
    expect(resolveTerminalInputFallbackAction({ pending: second, textareaValue: "  " })).toEqual({
      shouldClearTextarea: true,
      shouldWrite: false,
    });
  });

  it("marks pending composed characters inside a combined xterm data chunk", () => {
    const first = createPendingTerminalInputFallback("中");
    const second = createPendingTerminalInputFallback("文");

    markTerminalInputFallbackHandled([first, second], "中文");

    expect(resolveTerminalInputFallbackAction({ pending: first, textareaValue: "中文" })).toEqual({
      shouldClearTextarea: true,
      shouldWrite: false,
    });
    expect(resolveTerminalInputFallbackAction({ pending: second, textareaValue: "中文" })).toEqual({
      shouldClearTextarea: true,
      shouldWrite: false,
    });
  });

  it("marks pending composed text when xterm later emits it with Enter control data", () => {
    const pending = createPendingTerminalInputFallback("中文");

    markTerminalInputFallbackHandled([pending], "中文\r");

    expect(resolveTerminalInputFallbackAction({ pending, textareaValue: "中文" })).toEqual({
      shouldClearTextarea: true,
      shouldWrite: false,
    });
  });

  it("flushes composed text when xterm leaves it unhandled in textarea", () => {
    const pending = createPendingTerminalInputFallback("中");

    expect(resolveTerminalInputFallbackAction({ pending, textareaValue: "中" })).toEqual({
      shouldClearTextarea: true,
      shouldWrite: true,
    });
  });
});
