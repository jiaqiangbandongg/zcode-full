import type { MutableRefObject } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWorkspaceFileComposerMention,
  dispatchWorkspaceFileDragState,
  hasWorkspaceFileDragPayload,
  isWorkspaceFileDragStateEvent,
  parseWorkspaceFileDragPayload,
  serializeWorkspaceFileDragPayload,
  WORKSPACE_FILE_DRAG_STATE_EVENT,
  WORKSPACE_FILE_DRAG_MIME,
} from "@/lib/workspaceFileDrag.js";
import { appendWorkspaceFileMentionToComposer } from "@/lib/workspaceFileComposer.js";
import type { LexicalChatInputHandle } from "@/LexicalChatInput.js";

describe("workspace file drag payload", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("round-trips valid file payloads", () => {
    const payload = {
      type: "file" as const,
      workspacePath: "/workspace",
      workspaceIdentity: "ssh://dev/workspace",
      path: "/workspace/src/index.ts",
      relativePath: "src/index.ts",
      name: "index.ts",
    };

    expect(parseWorkspaceFileDragPayload(serializeWorkspaceFileDragPayload(payload))).toEqual(
      payload,
    );
  });

  it("round-trips valid directory payloads", () => {
    const payload = {
      type: "directory" as const,
      workspacePath: "/workspace",
      path: "/workspace/src",
      relativePath: "src",
      name: "src",
    };

    expect(parseWorkspaceFileDragPayload(serializeWorkspaceFileDragPayload(payload))).toEqual(
      payload,
    );
  });

  it("rejects malformed payloads", () => {
    expect(parseWorkspaceFileDragPayload("not-json")).toBeNull();
    expect(parseWorkspaceFileDragPayload(JSON.stringify({ type: "directory" }))).toBeNull();
    expect(parseWorkspaceFileDragPayload(JSON.stringify({ type: "unknown" }))).toBeNull();
  });

  it("detects workspace file drags from dataTransfer types before payload data is readable", () => {
    const dataTransfer = {
      types: [WORKSPACE_FILE_DRAG_MIME],
      getData: () => "",
    } as unknown as DataTransfer;

    expect(hasWorkspaceFileDragPayload(dataTransfer)).toBe(true);
  });

  it("dispatches drag state changes for prompt editors before dragover", () => {
    const windowTarget = new EventTarget();
    vi.stubGlobal("window", windowTarget);
    const states: boolean[] = [];

    windowTarget.addEventListener(WORKSPACE_FILE_DRAG_STATE_EVENT, (event) => {
      if (isWorkspaceFileDragStateEvent(event)) {
        states.push(event.detail.dragging);
      }
    });

    dispatchWorkspaceFileDragState(true);
    dispatchWorkspaceFileDragState(false);

    expect(states).toEqual([true, false]);
  });

  it("uses relative mention links inside the same workspace", () => {
    expect(
      createWorkspaceFileComposerMention(
        {
          type: "file",
          workspacePath: "/workspace",
          path: "/workspace/src/index.ts",
          relativePath: "src/index.ts",
          name: "index.ts",
        },
        "/workspace",
      ),
    ).toMatchObject({
      markdown: "[index.ts](./src/index.ts)",
      value: "src/index.ts",
      data: {
        path: "/workspace/src/index.ts",
        relativePath: "src/index.ts",
      },
    });
  });

  it("uses absolute mention links across workspaces to avoid resolving against the active project", () => {
    expect(
      createWorkspaceFileComposerMention(
        {
          type: "file",
          workspacePath: "/other-workspace",
          path: "/other-workspace/src/index.ts",
          relativePath: "src/index.ts",
          name: "index.ts",
        },
        "/workspace",
      ),
    ).toMatchObject({
      markdown: "[index.ts](/other-workspace/src/index.ts)",
      value: "/other-workspace/src/index.ts",
      data: {
        path: "/other-workspace/src/index.ts",
        relativePath: "/other-workspace/src/index.ts",
      },
    });
  });

  it("appends dropped file mentions through the shared composer helper", () => {
    let nextText = "";
    const appendFileMention = vi.fn();
    const focus = vi.fn();
    const inputApiRef = {
      current: {
        appendFileMention,
        focus,
      },
    } as MutableRefObject<LexicalChatInputHandle | null>;

    const result = appendWorkspaceFileMentionToComposer({
      inputApiRef,
      currentMarkdown: "请检查",
      payload: {
        type: "file",
        workspacePath: "/workspace",
        path: "/workspace/src/index.ts",
        relativePath: "src/index.ts",
        name: "index.ts",
      },
      workspacePath: "/workspace",
      onTextChange: (text) => {
        nextText = text;
      },
    });

    expect(result).toBe("请检查 [index.ts](./src/index.ts) ");
    expect(nextText).toBe(result);
    expect(appendFileMention).toHaveBeenCalledWith(
      "index.ts",
      "src/index.ts",
      "[index.ts](./src/index.ts)",
      {
        kind: "file",
        path: "/workspace/src/index.ts",
        relativePath: "src/index.ts",
      },
    );
    expect(focus).toHaveBeenCalled();
  });
});
