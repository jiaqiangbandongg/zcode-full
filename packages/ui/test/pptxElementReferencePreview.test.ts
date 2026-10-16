import { describe, expect, it } from "vitest";
import type { PptxElementReference } from "@/lib/pptxElementReference.js";
import { createPptxElementReferencePreviewSource } from "@/lib/pptxElementReferencePreview.js";

function makeReference(
  overrides: Partial<PptxElementReference> = {},
): PptxElementReference {
  return {
    bounds: { x: 10, y: 20, width: 300, height: 80 },
    capturedAt: 1,
    id: "reference-1",
    nodeId: "7",
    nodeName: "Title",
    nodeType: "shape",
    remoteSessionId: "remote-1",
    slideIndex: 2,
    slidePart: "ppt/slides/slide3.xml",
    sourceFingerprint: `sha256:${"a".repeat(64)}`,
    sourcePath: "/workspace/docs/deck.pptx",
    sourceTitle: "deck.pptx",
    workspaceIdentity: "ssh:user@host:/workspace",
    workspacePath: "/workspace",
    zIndex: 1,
    ...overrides,
  };
}

describe("PPTX element reference preview source", () => {
  it("maps a scoped reference to a repeatable file and page navigation request", () => {
    const scope = {
      workspacePath: "/mounted/workspace",
      workspaceIdentity: "ssh:user@host:/workspace",
      remoteSessionId: "remote-1",
    };
    const first = createPptxElementReferencePreviewSource(
      makeReference(),
      scope,
    );
    const second = createPptxElementReferencePreviewSource(
      makeReference(),
      scope,
    );

    expect(first).toMatchObject({
      type: "pptx",
      title: "deck.pptx",
      path: "/workspace/docs/deck.pptx",
      workspacePath: "/workspace",
      workspaceIdentity: "ssh:user@host:/workspace",
      workspaceRemoteSessionId: "remote-1",
      referenceNavigation: {
        pageIndex: 2,
        expectedSourceFingerprint: `sha256:${"a".repeat(64)}`,
      },
    });
    expect(first?.referenceNavigation.requestId).not.toBe(
      second?.referenceNavigation.requestId,
    );
  });

  it("rejects references outside the current workspace, remote session, or path", () => {
    const scope = {
      workspacePath: "/workspace",
      workspaceIdentity: "ssh:user@host:/workspace",
      remoteSessionId: "remote-1",
    };

    expect(
      createPptxElementReferencePreviewSource(
        makeReference({ remoteSessionId: "remote-2" }),
        scope,
      ),
    ).toBeNull();
    expect(
      createPptxElementReferencePreviewSource(
        makeReference({ workspaceIdentity: "ssh:user@other:/workspace" }),
        scope,
      ),
    ).toBeNull();
    expect(
      createPptxElementReferencePreviewSource(
        makeReference({ sourcePath: "/outside/deck.pptx" }),
        scope,
      ),
    ).toBeNull();
  });
});
