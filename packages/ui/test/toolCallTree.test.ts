import { describe, expect, it } from "vitest";
import { buildToolCallTree, reconcileToolCallTree } from "../src/lib/toolCallTree.js";

describe("buildToolCallTree", () => {
  it("groups child tool calls under their parent while preserving order", () => {
    const tree = buildToolCallTree([
      {
        toolId: "tool-root-before",
        kind: "other",
        title: "EnterPlanMode",
        input: null,
        status: "completed",
      },
      {
        toolId: "tool-task",
        kind: "think",
        title: "Task",
        input: { prompt: "Explore project" },
        status: "completed",
      },
      {
        toolId: "tool-child-read",
        parentToolUseId: "tool-task",
        kind: "read",
        title: "Read package.json",
        input: { file_path: "package.json" },
        status: "completed",
      },
      {
        toolId: "tool-child-list",
        parentToolUseId: "tool-task",
        kind: "execute",
        title: "ls -la",
        input: { command: "ls -la" },
        status: "completed",
      },
      {
        toolId: "tool-root-after",
        kind: "read",
        title: "Read README.md",
        input: { file_path: "README.md" },
        status: "completed",
      },
    ]);

    expect(tree.map((node) => node.toolCall.toolId)).toEqual([
      "tool-root-before",
      "tool-task",
      "tool-root-after",
    ]);
    expect(tree[1]?.childToolCalls.map((node) => node.toolCall.toolId)).toEqual([
      "tool-child-read",
      "tool-child-list",
    ]);
  });

  it("falls back to root when parent tool is missing", () => {
    const tree = buildToolCallTree([
      {
        toolId: "tool-child",
        parentToolUseId: "missing-parent",
        kind: "read",
        title: "Read package.json",
        input: { file_path: "package.json" },
        status: "completed",
      },
    ]);

    expect(tree).toHaveLength(1);
    expect(tree[0]?.toolCall.toolId).toBe("tool-child");
  });

  it("does not attach a tool call to itself", () => {
    const tree = buildToolCallTree([
      {
        toolId: "tool-self",
        parentToolUseId: "tool-self",
        kind: "think",
        title: "Task",
        input: null,
        status: "completed",
      },
    ]);

    expect(tree).toHaveLength(1);
    expect(tree[0]?.toolCall.toolId).toBe("tool-self");
    expect(tree[0]?.childToolCalls).toHaveLength(0);
  });

  it("reuses unchanged nodes and child arrays across equivalent inputs", () => {
    const firstTree = reconcileToolCallTree([
      {
        toolId: "tool-task",
        kind: "think",
        title: "Task",
        input: { prompt: "Explore project" },
        status: "completed",
      },
      {
        toolId: "tool-child-read",
        parentToolUseId: "tool-task",
        kind: "read",
        title: "Read package.json",
        input: { file_path: "package.json" },
        status: "completed",
      },
    ]);

    const secondTree = reconcileToolCallTree(
      [
        {
          toolId: "tool-task",
          kind: "think",
          title: "Task",
          input: { prompt: "Explore project" },
          status: "completed",
        },
        {
          toolId: "tool-child-read",
          parentToolUseId: "tool-task",
          kind: "read",
          title: "Read package.json",
          input: { file_path: "package.json" },
          status: "completed",
        },
      ],
      firstTree,
    );

    expect(secondTree).toBe(firstTree);
    expect(secondTree[0]).toBe(firstTree[0]);
    expect(secondTree[0]?.toolCall).toBe(firstTree[0]?.toolCall);
    expect(secondTree[0]?.childToolCalls).toBe(firstTree[0]?.childToolCalls);
    expect(secondTree[0]?.childToolCalls[0]).toBe(firstTree[0]?.childToolCalls[0]);
  });

  it("replaces only the changed branch when a child tool call changes", () => {
    const firstTree = reconcileToolCallTree([
      {
        toolId: "tool-task",
        kind: "think",
        title: "Task",
        input: { prompt: "Explore project" },
        status: "completed",
      },
      {
        toolId: "tool-child-read",
        parentToolUseId: "tool-task",
        kind: "read",
        title: "Read package.json",
        input: { file_path: "package.json" },
        status: "pending",
      },
      {
        toolId: "tool-root-after",
        kind: "read",
        title: "Read README.md",
        input: { file_path: "README.md" },
        status: "completed",
      },
    ]);

    const secondTree = reconcileToolCallTree(
      [
        {
          toolId: "tool-task",
          kind: "think",
          title: "Task",
          input: { prompt: "Explore project" },
          status: "completed",
        },
        {
          toolId: "tool-child-read",
          parentToolUseId: "tool-task",
          kind: "read",
          title: "Read package.json",
          input: { file_path: "package.json" },
          status: "completed",
        },
        {
          toolId: "tool-root-after",
          kind: "read",
          title: "Read README.md",
          input: { file_path: "README.md" },
          status: "completed",
        },
      ],
      firstTree,
    );

    expect(secondTree).not.toBe(firstTree);
    expect(secondTree[0]).not.toBe(firstTree[0]);
    expect(secondTree[0]?.toolCall).toBe(firstTree[0]?.toolCall);
    expect(secondTree[0]?.childToolCalls[0]).not.toBe(firstTree[0]?.childToolCalls[0]);
    expect(secondTree[1]).toBe(firstTree[1]);
  });
});
