// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  dispatchPptxElementReferenceAddToChat,
  type PptxElementReference,
} from "@/lib/pptxElementReference.js";
import { usePptxElementReferences } from "@/v4/composer/usePptxElementReferences.js";

function makeReference(
  overrides: Partial<PptxElementReference> = {},
): PptxElementReference {
  return {
    bounds: { x: 0, y: 0, width: 100, height: 40 },
    capturedAt: 1,
    id: "reference-1",
    nodeId: "7",
    nodeName: "Title 1",
    nodeType: "shape",
    remoteSessionId: "remote-1",
    slideIndex: 0,
    slidePart: "ppt/slides/slide1.xml",
    sourceFingerprint: `sha256:${"a".repeat(64)}`,
    sourcePath: "/workspace/deck.pptx",
    sourceTitle: "deck.pptx",
    workspaceIdentity: "ssh:user@host:/workspace",
    workspacePath: "/workspace",
    zIndex: 0,
    ...overrides,
  };
}

describe("usePptxElementReferences", () => {
  it("只接收同 workspace/remote scope 的事件，并在 draft scope 切换时清空", () => {
    const hook = renderHook(
      ({ scopeId }) =>
        usePptxElementReferences({
          workspacePath: "/mounted/workspace",
          workspaceIdentity: "ssh:user@host:/workspace",
          remoteSessionId: "remote-1",
          scopeId,
        }),
      { initialProps: { scopeId: "draft-a" } },
    );

    act(() => {
      dispatchPptxElementReferenceAddToChat(
        makeReference({ remoteSessionId: "remote-2" }),
      );
    });
    expect(hook.result.current.references).toHaveLength(0);

    act(() => dispatchPptxElementReferenceAddToChat(makeReference()));
    expect(hook.result.current.references).toHaveLength(1);

    hook.rerender({ scopeId: "session-b" });
    expect(hook.result.current.references).toHaveLength(0);
  });

  it("禁用全局监听时不接收 Preview Pane 引用", () => {
    const hook = renderHook(() =>
      usePptxElementReferences({
        workspacePath: "/workspace",
        workspaceIdentity: "ssh:user@host:/workspace",
        remoteSessionId: "remote-1",
        listenAddToChatEvents: false,
        scopeId: "draft-a",
      }),
    );

    act(() => dispatchPptxElementReferenceAddToChat(makeReference()));
    expect(hook.result.current.references).toHaveLength(0);
  });
});
