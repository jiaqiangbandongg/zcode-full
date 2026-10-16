import { describe, expect, it, vi } from "vitest";
import { createWebRemoteControlLifecycleRecovery } from "../src/webRemoteControlLifecycle.js";

class FakeDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible";
}

describe("createWebRemoteControlLifecycleRecovery", () => {
  it("ignores pageshow before the page has ever been suspended", () => {
    const documentTarget = new FakeDocument();
    const windowTarget = new EventTarget();
    const onSuspend = vi.fn();
    const onRecover = vi.fn();

    const lifecycle = createWebRemoteControlLifecycleRecovery({
      documentTarget,
      windowTarget,
      onSuspend,
      onRecover,
    });

    windowTarget.dispatchEvent(new Event("pageshow"));

    expect(onSuspend).not.toHaveBeenCalled();
    expect(onRecover).not.toHaveBeenCalled();

    lifecycle.dispose();
  });

  it("suspends on lifecycle pause and recovers on visible, pageshow, and online", () => {
    const documentTarget = new FakeDocument();
    const windowTarget = new EventTarget();
    const onSuspend = vi.fn();
    const onRecover = vi.fn();

    const lifecycle = createWebRemoteControlLifecycleRecovery({
      documentTarget,
      windowTarget,
      onSuspend,
      onRecover,
    });

    documentTarget.visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    documentTarget.visibilityState = "visible";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    windowTarget.dispatchEvent(new Event("pagehide"));
    windowTarget.dispatchEvent(new Event("pageshow"));
    windowTarget.dispatchEvent(new Event("pagehide"));
    windowTarget.dispatchEvent(new Event("online"));

    expect(onSuspend).toHaveBeenCalledTimes(3);
    expect(onRecover).toHaveBeenCalledTimes(3);

    lifecycle.dispose();
    windowTarget.dispatchEvent(new Event("online"));

    expect(onRecover).toHaveBeenCalledTimes(3);
  });
});
