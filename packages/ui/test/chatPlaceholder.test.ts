import { describe, expect, it } from "vitest";
import {
  resolveChatPlaceholderKey,
  shouldDeferChatPlaceholder,
} from "../src/lib/chatPlaceholder.js";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

describe("resolveChatPlaceholderKey", () => {
  it("returns newTask for empty conversation", () => {
    expect(
      resolveChatPlaceholderKey({
        hasHistoryMessages: false,
        isTaskProcessing: false,
      }),
    ).toBe("chat.placeholder.newTask");
  });

  it("returns compact newTask copy for an empty mobile remote conversation", () => {
    expect(
      resolveChatPlaceholderKey({
        hasHistoryMessages: false,
        isTaskProcessing: false,
        compactNewTask: true,
      }),
    ).toBe("chat.placeholder.newTaskMobile");
    expect(enUS["chat.placeholder.newTaskMobile"]).toBe("Ask ZCode anything…");
    expect(zhCN["chat.placeholder.newTaskMobile"]).toBe("向 ZCode 提问…");
  });

  it("returns newTask while first turn is processing", () => {
    expect(
      resolveChatPlaceholderKey({
        hasHistoryMessages: false,
        isTaskProcessing: true,
      }),
    ).toBe("chat.placeholder.newTask");
  });

  it("returns followUpAsk when conversation is idle", () => {
    expect(
      resolveChatPlaceholderKey({
        hasHistoryMessages: true,
        isTaskProcessing: false,
      }),
    ).toBe("chat.placeholder.followUpAsk");
  });

  it("returns followUpQueue when follow-up can be queued", () => {
    expect(
      resolveChatPlaceholderKey({
        hasHistoryMessages: true,
        isTaskProcessing: true,
      }),
    ).toBe("chat.placeholder.followUpQueue");
  });
});

describe("shouldDeferChatPlaceholder", () => {
  it("defers placeholder while bound task is creating", () => {
    expect(
      shouldDeferChatPlaceholder({
        hasBoundTask: true,
        taskStatus: "creating",
      }),
    ).toBe(true);
  });

  it("defers placeholder while bound task is restoring", () => {
    expect(
      shouldDeferChatPlaceholder({
        hasBoundTask: true,
        taskStatus: "restoring",
      }),
    ).toBe(true);
  });

  it("does not defer placeholder after task becomes ready", () => {
    expect(
      shouldDeferChatPlaceholder({
        hasBoundTask: true,
        taskStatus: "ready",
      }),
    ).toBe(false);
  });

  it("does not defer placeholder in draft mode", () => {
    expect(
      shouldDeferChatPlaceholder({
        hasBoundTask: false,
        taskStatus: "creating",
      }),
    ).toBe(false);
  });
});
