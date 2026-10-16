// @vitest-environment jsdom
import { act, createElement, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  getPrimaryFollowupModifierSnapshot,
  subscribePrimaryFollowupModifier,
} from "@/v4/composer/usePrimaryFollowupModifier.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function ModifierProbe() {
  const pressed = useSyncExternalStore(
    subscribePrimaryFollowupModifier,
    getPrimaryFollowupModifierSnapshot,
    () => false,
  );
  return createElement("output", { "data-pressed": String(pressed) });
}

afterEach(() => {
  window.dispatchEvent(new Event("blur"));
  document.body.innerHTML = "";
});

describe("primary follow-up modifier store", () => {
  it("publishes modifier keydown, keyup, and blur without per-composer listeners", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(createElement(ModifierProbe)));

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { ctrlKey: true }));
    });
    expect(container.querySelector("output")?.dataset.pressed).toBe("true");

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keyup", { ctrlKey: false }));
    });
    expect(container.querySelector("output")?.dataset.pressed).toBe("false");

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { ctrlKey: true }));
      window.dispatchEvent(new Event("blur"));
    });
    expect(container.querySelector("output")?.dataset.pressed).toBe("false");

    act(() => root.unmount());
  });
});
