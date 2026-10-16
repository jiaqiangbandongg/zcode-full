import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRunningBackgroundTaskElapsedClock } from "@/hooks/useRunningBackgroundTaskElapsedClock.js";

function createMinimalElement(ownerDocument: Document, tagName = "div") {
  const element = {
    addEventListener: () => {},
    appendChild: (child: { parentNode?: unknown }) => {
      child.parentNode = element;
      return child;
    },
    childNodes: [] as unknown[],
    getAttribute: () => null,
    insertBefore: (child: { parentNode?: unknown }) => {
      child.parentNode = element;
      return child;
    },
    nodeName: tagName.toUpperCase(),
    nodeType: 1,
    ownerDocument,
    parentNode: null as unknown,
    removeChild: (child: { parentNode?: unknown }) => {
      child.parentNode = null;
      return child;
    },
    removeEventListener: () => {},
    removeAttribute: () => {},
    setAttribute: () => {},
    style: {},
    tagName: tagName.toUpperCase(),
  };
  return element as unknown as Element;
}

function installMinimalDom() {
  const documentMock = {
    addEventListener: () => {},
    createElement: (tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createTextNode: (nodeValue: string) => ({
      nodeType: 3,
      nodeValue,
      ownerDocument: documentMock,
      parentNode: null,
    }),
    nodeType: 9,
    removeEventListener: () => {},
  } as unknown as Document;
  const windowMock = {
    document: documentMock,
    HTMLIFrameElement: function HTMLIFrameElement() {},
    HTMLElement: function HTMLElement() {},
    Node: function Node() {},
  };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: documentMock,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: windowMock,
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  return createMinimalElement(documentMock);
}

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown })
    .IS_REACT_ACT_ENVIRONMENT;
});

describe("useRunningBackgroundTaskElapsedClock", () => {
  it("keeps the existing second boundary when one of several running tasks completes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const root: Root = createRoot(installMinimalDom());
    let latestNow = 0;

    function Harness({ runningTaskCount }: { runningTaskCount: number }) {
      latestNow = useRunningBackgroundTaskElapsedClock(runningTaskCount);
      return null;
    }

    act(() => {
      root.render(createElement(Harness, { runningTaskCount: 2 }));
    });
    expect(latestNow).toBe(100_000);

    act(() => {
      vi.advanceTimersByTime(900);
      root.render(createElement(Harness, { runningTaskCount: 1 }));
    });
    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(latestNow).toBe(101_000);

    act(() => {
      root.unmount();
    });
  });
});
