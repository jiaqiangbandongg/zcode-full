import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
import { cn } from "@/components/lib/utils.js";
import {
  resolveChatEnterShortcut,
  resolveChatEnterSubmits,
  resolveMobileInputTextSizeClassName,
  shouldAvoidIosInputFocusZoom,
} from "@/lib/mobileTextInput.js";

function readSource(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

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
    const composerSource = readSource("packages/ui/src/v4/ConversationComposer.tsx");
    expect(composerSource).not.toContain('if (routingMode === "startNow")');
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

  it("keeps desktop and non-remote input typography unchanged", () => {
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
    expect(
      resolveMobileInputTextSizeClassName({
        avoidIosInputFocusZoom: false,
      }),
    ).toBe("text-ui-base leading-5");
  });

  it("uses a fixed 16px token for mobile remote input even with a 12px UI preference", () => {
    expect(
      shouldAvoidIosInputFocusZoom({
        isMobileTextInputViewport: true,
        isWebRemoteControl: true,
      }),
    ).toBe(true);
    const className = resolveMobileInputTextSizeClassName({
      avoidIosInputFocusZoom: true,
    });
    const stylesSource = readSource("packages/ui/src/styles.css");

    expect(className).toBe("text-mobile-input-safe leading-6");
    expect(cn("text-ui-base", className)).toBe("text-mobile-input-safe leading-6");
    expect(cn("text-ui-base", "text-ui-xl")).toBe("text-ui-xl");
    expect(cn("text-ui-base", "text-ui-caption")).toBe("text-ui-caption");
    expect(stylesSource).toContain("--text-mobile-input-safe: 16px;");
    expect(stylesSource).toContain("--text-ui-xl: calc(var(--ui-font-size) + 4px);");
    expect(stylesSource).toContain("--text-ui-lg: calc(var(--ui-font-size) + 2px);");
  });

  it("wires the zoom guard through remote composer inputs", () => {
    const composerSource = readSource("packages/ui/src/v4/ConversationComposer.tsx");
    const interactionDialogSource = readSource("packages/ui/src/v4/V4InteractionDialogs.tsx");
    const permissionDialogSource = readSource("packages/ui/src/PermissionDialog.tsx");
    const sessionPaneSource = readSource("packages/ui/src/v4/SessionPane.tsx");
    const promptEditorSource = readSource("packages/ui/src/prompt-editor/ChatPromptEditor.tsx");
    const lexicalInputSource = readSource("packages/ui/src/LexicalChatInput.tsx");

    expect(composerSource).toContain("shouldAvoidIosInputFocusZoom({");
    expect(composerSource).toContain("isWebRemoteControl,");
    expect(composerSource).toContain("isMobileTextInputViewport,");
    expect(composerSource).toContain("preferEnterNewline: isWebRemoteControl,");
    expect(composerSource).toContain("avoidIosInputFocusZoom={avoidIosInputFocusZoom}");
    expect(composerSource).toContain("compactPlaceholder={compactMobilePlaceholder}");
    expect(sessionPaneSource).toContain("isWebRemoteControl={compactForRemoteControl}");
    expect(interactionDialogSource).toContain("isWebRemoteControl={isWebRemoteControl}");
    expect(permissionDialogSource).toContain("useIsMobileTextInputViewport");
    expect(permissionDialogSource).toContain("resolveMobileInputTextSizeClassName({");
    expect(permissionDialogSource).toContain("avoidIosInputFocusZoom");
    expect(promptEditorSource).toContain("avoidIosInputFocusZoom={avoidIosInputFocusZoom}");
    expect(promptEditorSource).toContain("compactPlaceholder={compactPlaceholder}");
    expect(lexicalInputSource).toContain("resolveMobileInputTextSizeClassName({");
    expect(lexicalInputSource).toContain('compactPlaceholder ? "line-clamp-2" : ""');
    expect(lexicalInputSource).not.toContain("user-scalable=no");
    expect(lexicalInputSource).not.toContain("maximum-scale");
  });
});
