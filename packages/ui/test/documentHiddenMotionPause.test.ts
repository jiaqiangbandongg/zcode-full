// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  DOCUMENT_HIDDEN_ATTRIBUTE,
  installDocumentHiddenMotionPause,
} from "@/lib/documentHiddenMotionPause.js";

let visibilityState: DocumentVisibilityState = "visible";
Object.defineProperty(document, "visibilityState", {
  configurable: true,
  get: () => visibilityState,
});

function setVisibility(next: DocumentVisibilityState) {
  visibilityState = next;
  document.dispatchEvent(new Event("visibilitychange"));
}

const root = () => document.documentElement;

afterEach(() => {
  visibilityState = "visible";
  root().removeAttribute(DOCUMENT_HIDDEN_ATTRIBUTE);
});

describe("installDocumentHiddenMotionPause", () => {
  it("安装时按当前可见性立即同步标记", () => {
    visibilityState = "hidden";
    const dispose = installDocumentHiddenMotionPause(document);
    expect(root().hasAttribute(DOCUMENT_HIDDEN_ATTRIBUTE)).toBe(true);
    dispose();
  });

  it("跟随 visibilitychange 切换标记", () => {
    const dispose = installDocumentHiddenMotionPause(document);
    expect(root().hasAttribute(DOCUMENT_HIDDEN_ATTRIBUTE)).toBe(false);

    setVisibility("hidden");
    expect(root().hasAttribute(DOCUMENT_HIDDEN_ATTRIBUTE)).toBe(true);

    setVisibility("visible");
    expect(root().hasAttribute(DOCUMENT_HIDDEN_ATTRIBUTE)).toBe(false);
    dispose();
  });

  it("dispose 后移除监听并清掉标记", () => {
    const dispose = installDocumentHiddenMotionPause(document);
    setVisibility("hidden");
    dispose();
    expect(root().hasAttribute(DOCUMENT_HIDDEN_ATTRIBUTE)).toBe(false);

    setVisibility("hidden");
    expect(root().hasAttribute(DOCUMENT_HIDDEN_ATTRIBUTE)).toBe(false);
  });
});
