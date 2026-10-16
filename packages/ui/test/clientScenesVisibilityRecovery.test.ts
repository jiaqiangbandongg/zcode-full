// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { createClientScenesVisibilityRecovery } from "@/hooks/clientScenesVisibilityRecovery.js";

function createVisibilityDocument() {
  let visibilityState: DocumentVisibilityState = "visible";
  const listeners = new Set<EventListenerOrEventListenerObject>();
  const documentTarget = {
    get visibilityState() {
      return visibilityState;
    },
    addEventListener(_type: string, listener: EventListenerOrEventListenerObject) {
      listeners.add(listener);
    },
    removeEventListener(_type: string, listener: EventListenerOrEventListenerObject) {
      listeners.delete(listener);
    },
  } as Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;

  return {
    documentTarget,
    setVisibility(next: DocumentVisibilityState) {
      visibilityState = next;
      const event = new Event("visibilitychange");
      for (const listener of listeners) {
        if (typeof listener === "function") listener(event);
        else listener.handleEvent(event);
      }
    },
  };
}

describe("Client Scenes visibility recovery", () => {
  it("revalidates once per authority only after hidden becomes visible", () => {
    const target = createVisibilityDocument();
    const recovery = createClientScenesVisibilityRecovery(target.documentTarget);
    const first = vi.fn();
    const duplicate = vi.fn();
    const otherAuthority = vi.fn();
    const sharedAuthority = {};
    const separateAuthority = {};
    const disposeFirst = recovery.subscribe(sharedAuthority, first);
    const disposeDuplicate = recovery.subscribe(sharedAuthority, duplicate);
    const disposeOther = recovery.subscribe(separateAuthority, otherAuthority);

    target.setVisibility("visible");
    target.setVisibility("hidden");
    target.setVisibility("hidden");
    expect(first).not.toHaveBeenCalled();
    expect(duplicate).not.toHaveBeenCalled();
    expect(otherAuthority).not.toHaveBeenCalled();

    target.setVisibility("visible");
    target.setVisibility("visible");
    expect(first).toHaveBeenCalledOnce();
    expect(duplicate).not.toHaveBeenCalled();
    expect(otherAuthority).toHaveBeenCalledOnce();

    disposeFirst();
    target.setVisibility("hidden");
    target.setVisibility("visible");
    expect(duplicate).toHaveBeenCalledOnce();

    disposeDuplicate();
    disposeOther();
    target.setVisibility("hidden");
    target.setVisibility("visible");
    expect(duplicate).toHaveBeenCalledOnce();
    expect(otherAuthority).toHaveBeenCalledTimes(2);

    const remounted = vi.fn();
    recovery.subscribe(sharedAuthority, remounted);
    expect(remounted).toHaveBeenCalledOnce();
  });
});
