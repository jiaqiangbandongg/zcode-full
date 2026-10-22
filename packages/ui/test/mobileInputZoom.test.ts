import { describe, expect, it } from "vitest";
import {
  shouldResetLexicalEditorAfterSubmit,
  shouldSubmitLexicalEnter,
  shouldSubmitLexicalModifiedEnter,
} from "@/LexicalChatInput.js";
import {
  isPrimaryFollowupModifierPressed,
  resolveOppositeFollowupDelivery,
  resolveFollowupModifierTooltip,
  shouldEnableModifiedEnterSubmit,
  shouldReverseFollowupDeliveryForPointer,
} from "@/v4/composer/followupModeSettings.js";
import {
  resolveChatEnterShortcut,
  resolveChatEnterSubmits,
  shouldAvoidIosInputFocusZoom,
} from "@/lib/mobileTextInput.js";

describe("mobile text input zoom guard", () => {
  it("keeps modified submit on desktop drafts and Windows coarse-pointer viewports", () => {
    expect(
      shouldEnableModifiedEnterSubmit({
        inputRoutingMode: "startNow",
        isMobileTextInputViewport: true,
        isWebRemoteControl: false,
      }),
    ).toBe(true);
    expect(
      shouldEnableModifiedEnterSubmit({
        inputRoutingMode: "enqueue",
        isMobileTextInputViewport: true,
        isWebRemoteControl: false,
      }),
    ).toBe(true);
    expect(
      shouldEnableModifiedEnterSubmit({
        inputRoutingMode: "enqueue",
        isMobileTextInputViewport: true,
        isWebRemoteControl: true,
      }),
    ).toBe(false);
    expect(
      shouldEnableModifiedEnterSubmit({
        inputRoutingMode: "reject",
        isMobileTextInputViewport: false,
        isWebRemoteControl: false,
      }),
    ).toBe(false);
  });

  it("resolves Cmd/Ctrl+Enter as send-now for queue and queue for guide", () => {
    expect(resolveOppositeFollowupDelivery("queue")).toBe("startNow");
    expect(resolveOppositeFollowupDelivery("guide")).toBe("queue");
    expect(
      shouldSubmitLexicalModifiedEnter({
        ctrlKey: true,
        modifiedEnterSubmits: true,
        text: "opposite delivery",
      }),
    ).toBe(true);
    expect(
      shouldSubmitLexicalModifiedEnter({
        metaKey: true,
        modifiedEnterSubmits: true,
        text: "opposite delivery",
      }),
    ).toBe(true);
    expect(
      shouldSubmitLexicalModifiedEnter({
        ctrlKey: true,
        isComposing: true,
        modifiedEnterSubmits: true,
        text: "IME",
      }),
    ).toBe(false);
    expect(
      shouldSubmitLexicalModifiedEnter({
        ctrlKey: true,
        modifiedEnterSubmits: true,
        shiftKey: true,
        text: "keep newline",
      }),
    ).toBe(false);
  });

  it("only clears the Lexical editor when the submit callback accepts the clear", () => {
    expect(shouldResetLexicalEditorAfterSubmit()).toBe(true);
    expect(shouldResetLexicalEditorAfterSubmit(true)).toBe(true);
    expect(shouldResetLexicalEditorAfterSubmit(false)).toBe(false);
  });

  it("only reverses pointer delivery for an enabled desktop modifier click", () => {
    expect(
      shouldReverseFollowupDeliveryForPointer({ enabled: true, metaKey: true, ctrlKey: false }),
    ).toBe(true);
    expect(
      shouldReverseFollowupDeliveryForPointer({ enabled: true, metaKey: false, ctrlKey: true }),
    ).toBe(true);
    expect(
      shouldReverseFollowupDeliveryForPointer({ enabled: true, metaKey: false, ctrlKey: false }),
    ).toBe(false);
    expect(
      shouldReverseFollowupDeliveryForPointer({ enabled: false, metaKey: true, ctrlKey: false }),
    ).toBe(false);
  });

  it("resolves the automatic opposite-action tooltip with a platform shortcut", () => {
    expect(
      resolveFollowupModifierTooltip({
        enabled: true,
        canSend: true,
        modifierPressed: true,
        followupMode: "queue",
        isApplePlatform: true,
      }),
    ).toEqual({
      delivery: "startNow",
      shortcut: "⌘ + Enter",
      titleId: "chat.followup.sendNow",
    });
    expect(
      resolveFollowupModifierTooltip({
        enabled: true,
        canSend: true,
        modifierPressed: true,
        followupMode: "guide",
        isApplePlatform: false,
      }),
    ).toEqual({
      delivery: "queue",
      shortcut: "Ctrl + Enter",
      titleId: "chat.followup.addToQueue",
    });
    expect(
      resolveFollowupModifierTooltip({
        enabled: true,
        canSend: false,
        modifierPressed: true,
        followupMode: "queue",
        isApplePlatform: true,
      }),
    ).toBeNull();
  });

  it("tracks only the platform primary follow-up modifier", () => {
    expect(
      isPrimaryFollowupModifierPressed({ isApplePlatform: true, metaKey: true, ctrlKey: false }),
    ).toBe(true);
    expect(
      isPrimaryFollowupModifierPressed({ isApplePlatform: true, metaKey: false, ctrlKey: true }),
    ).toBe(false);
    expect(
      isPrimaryFollowupModifierPressed({ isApplePlatform: false, metaKey: false, ctrlKey: true }),
    ).toBe(true);
    expect(
      isPrimaryFollowupModifierPressed({ isApplePlatform: false, metaKey: true, ctrlKey: false }),
    ).toBe(false);
  });

  it("keeps Enter as newline for mobile web remote control only", () => {
    const mobileRemoteEnterSubmits = resolveChatEnterSubmits({
      isMobileTextInputViewport: true,
      preferEnterNewline: true,
    });

    expect(mobileRemoteEnterSubmits).toBe(false);
    expect(resolveChatEnterShortcut({ enterSubmits: mobileRemoteEnterSubmits })).toBeUndefined();
    expect(
      shouldSubmitLexicalEnter({
        enterSubmits: mobileRemoteEnterSubmits,
        text: "first line",
      }),
    ).toBe(false);
    expect(
      resolveChatEnterSubmits({
        isMobileTextInputViewport: false,
        preferEnterNewline: true,
      }),
    ).toBe(true);
  });

  it("desktop viewports and non-remote inputs do not enable the zoom guard", () => {
    expect(
      shouldAvoidIosInputFocusZoom({
        isMobileTextInputViewport: false,
        isWebRemoteControl: true,
      }),
    ).toBe(false);
    expect(
      shouldAvoidIosInputFocusZoom({
        isMobileTextInputViewport: true,
        isWebRemoteControl: false,
      }),
    ).toBe(false);
  });

  it("enables the zoom guard for mobile remote input", () => {
    expect(
      shouldAvoidIosInputFocusZoom({
        isMobileTextInputViewport: true,
        isWebRemoteControl: true,
      }),
    ).toBe(true);
  });
});
