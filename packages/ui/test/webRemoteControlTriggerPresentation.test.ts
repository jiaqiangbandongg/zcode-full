import { describe, expect, it } from "vitest";
import { getWebRemoteControlTriggerPresentation } from "@/WorkspaceWebRemoteControlTrigger.js";

const formatMessage = ({ id }: { id: string }) => id;

describe("getWebRemoteControlTriggerPresentation", () => {
  it("uses success styling and a connected tooltip when a phone is paired", () => {
    const presentation = getWebRemoteControlTriggerPresentation(
      { status: "active", mobileConnected: true },
      formatMessage,
    );

    expect(presentation.iconClassName).toContain("text-success");
    expect(presentation.tooltip).toBe("webRemoteControl.triggerStatus.connected");
  });

  it("uses warning styling while waiting for phone pairing", () => {
    const presentation = getWebRemoteControlTriggerPresentation(
      { status: "running", mobileConnected: false },
      formatMessage,
    );

    expect(presentation.iconClassName).toContain("text-warning");
    expect(presentation.tooltip).toBe("webRemoteControl.triggerStatus.waiting");
  });

  it("does not show connected while the relay is reconnecting with stale mobile state", () => {
    const presentation = getWebRemoteControlTriggerPresentation(
      { status: "starting", mobileConnected: true },
      formatMessage,
    );

    expect(presentation.iconClassName).toContain("text-warning");
    expect(presentation.tooltip).toBe("webRemoteControl.triggerStatus.starting");
  });

  it("uses destructive styling for failed remote control sessions", () => {
    const presentation = getWebRemoteControlTriggerPresentation(
      { status: "error" },
      formatMessage,
    );

    expect(presentation.iconClassName).toContain("text-destructive");
    expect(presentation.tooltip).toBe("webRemoteControl.triggerStatus.error");
  });
});
