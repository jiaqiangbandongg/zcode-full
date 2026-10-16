import { describe, expect, it } from "vitest";
import {
  canForkFromTaskRuntimeStatus,
  deriveChatTaskStatusForMainActivity,
  deriveChatComposerStatusFromTaskRuntime,
  getChatSubmitLabelId,
  isChatComposerEditingDisabled,
  isChatComposerSubmissionBlocked,
  isChatTaskRunning,
  shouldShowChatSubmitSpinner,
  shouldShowChatThinkingShimmer,
} from "../src/lib/chatStatus.js";

describe("deriveChatComposerStatusFromTaskRuntime", () => {
  it("maps streaming tasks to the stop-button state", () => {
    expect(deriveChatComposerStatusFromTaskRuntime("streaming")).toBe("streaming");
  });

  it("resets completed and ready tasks back to the send-button state", () => {
    expect(deriveChatComposerStatusFromTaskRuntime("completed")).toBe("idle");
    expect(deriveChatComposerStatusFromTaskRuntime("ready")).toBe("idle");
  });
});

describe("getChatSubmitLabelId", () => {
  it("returns preparing while workspace ZCode Agent is still initializing", () => {
    expect(getChatSubmitLabelId("submitting", "initializing", "idle")).toBe("chat.preparing");
  });

  it("returns preparing while task is still being created or restored", () => {
    expect(getChatSubmitLabelId("submitting", "ready", "creating")).toBe("chat.preparing");
    expect(getChatSubmitLabelId("submitting", "ready", "restoring")).toBe("chat.preparing");
  });

  it("keeps preparing during submitting even if task runtime already flipped to streaming", () => {
    expect(getChatSubmitLabelId("submitting", "ready", "streaming")).toBe("chat.preparing");
  });

  it("falls back to send outside of the submitting state", () => {
    expect(getChatSubmitLabelId("idle", "ready", "ready")).toBe("chat.send");
  });
});

describe("chat composer availability", () => {
  it("allows editing while the assistant is streaming", () => {
    expect(isChatComposerEditingDisabled("streaming")).toBe(false);
  });

  it("keeps editing enabled while the request is still submitting", () => {
    expect(isChatComposerEditingDisabled("submitting")).toBe(false);
  });

  it("allows submission while the assistant is streaming so the next prompt can be queued", () => {
    expect(isChatComposerSubmissionBlocked("streaming")).toBe(false);
  });

  it("still blocks submission while submitting", () => {
    expect(isChatComposerSubmissionBlocked("submitting")).toBe(true);
  });
});

describe("shouldShowChatSubmitSpinner", () => {
  it("shows a spinner while a prompt is still submitting", () => {
    expect(shouldShowChatSubmitSpinner("submitting")).toBe(true);
  });

  it("hides the spinner outside the submitting window", () => {
    expect(shouldShowChatSubmitSpinner("idle")).toBe(false);
    expect(shouldShowChatSubmitSpinner("streaming")).toBe(false);
    expect(shouldShowChatSubmitSpinner("error")).toBe(false);
  });
});

describe("isChatTaskRunning", () => {
  it("treats creating, restoring and streaming as running", () => {
    expect(isChatTaskRunning("creating")).toBe(true);
    expect(isChatTaskRunning("restoring")).toBe(true);
    expect(isChatTaskRunning("streaming")).toBe(true);
  });

  it("treats idle, ready, completed and failed as not running", () => {
    expect(isChatTaskRunning("idle")).toBe(false);
    expect(isChatTaskRunning("ready")).toBe(false);
    expect(isChatTaskRunning("completed")).toBe(false);
    expect(isChatTaskRunning("failed")).toBe(false);
  });
});

describe("deriveChatTaskStatusForMainActivity", () => {
  it("keeps raw streaming for background-only task status but hides main loading state", () => {
    expect(deriveChatTaskStatusForMainActivity("streaming", false)).toBe("completed");
    expect(deriveChatTaskStatusForMainActivity("streaming", true)).toBe("streaming");
  });

  it("does not rewrite non-streaming task statuses", () => {
    expect(deriveChatTaskStatusForMainActivity("creating", false)).toBe("creating");
    expect(deriveChatTaskStatusForMainActivity("completed", false)).toBe("completed");
  });
});

describe("canForkFromTaskRuntimeStatus", () => {
  it("allows fork only from stable completed-like runtime states", () => {
    expect(canForkFromTaskRuntimeStatus("idle")).toBe(true);
    expect(canForkFromTaskRuntimeStatus("ready")).toBe(true);
    expect(canForkFromTaskRuntimeStatus("completed")).toBe(true);
  });

  it("blocks fork while active, not ready, or failed", () => {
    expect(canForkFromTaskRuntimeStatus("creating")).toBe(false);
    expect(canForkFromTaskRuntimeStatus("restoring")).toBe(false);
    expect(canForkFromTaskRuntimeStatus("streaming")).toBe(false);
    expect(canForkFromTaskRuntimeStatus("notReady")).toBe(false);
    expect(canForkFromTaskRuntimeStatus("failed")).toBe(false);
  });
});

describe("shouldShowChatThinkingShimmer", () => {
  it("shows thinking only while creating or streaming", () => {
    expect(shouldShowChatThinkingShimmer("creating")).toBe(true);
    expect(shouldShowChatThinkingShimmer("streaming")).toBe(true);
  });

  it("does not show thinking while restoring", () => {
    expect(shouldShowChatThinkingShimmer("restoring")).toBe(false);
  });
});
