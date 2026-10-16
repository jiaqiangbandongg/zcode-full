import type { TaskChatToolCall } from "@/lib/taskChatMessageTypes.js";

export interface TaskChatToolCallTreeNode {
  toolCall: TaskChatToolCall;
  childToolCalls: TaskChatToolCallTreeNode[];
}

interface ToolCallTreeDraftNode {
  toolCall: TaskChatToolCall;
  childToolCalls: ToolCallTreeDraftNode[];
}

interface DeepEqualBudget {
  remaining: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function areUnknownValuesEqual(left: unknown, right: unknown, budget: DeepEqualBudget): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (typeof left !== typeof right || left === null || right === null) {
    return false;
  }
  if (typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  budget.remaining -= 1;
  if (budget.remaining < 0) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((item, index) => areUnknownValuesEqual(item, right[index], budget));
  }
  if (!isPlainObject(left) || !isPlainObject(right)) {
    return false;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  return leftKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(right, key) &&
      areUnknownValuesEqual(left[key], right[key], budget),
  );
}

export function areTaskChatToolCallsRenderEqual(
  left: TaskChatToolCall,
  right: TaskChatToolCall,
): boolean {
  if (left === right) {
    return true;
  }
  return (
    left.toolId === right.toolId &&
    (left.parentToolUseId ?? null) === (right.parentToolUseId ?? null) &&
    left.toolName === right.toolName &&
    left.kind === right.kind &&
    left.title === right.title &&
    left.status === right.status &&
    left.content === right.content &&
    left.thought === right.thought &&
    left.error === right.error &&
    left.startedAt === right.startedAt &&
    areUnknownValuesEqual(left.input, right.input, { remaining: 500 }) &&
    areUnknownValuesEqual(left.output, right.output, { remaining: 500 }) &&
    areUnknownValuesEqual(left.raw, right.raw, { remaining: 500 }) &&
    areUnknownValuesEqual(left.snapshotRefs, right.snapshotRefs, { remaining: 500 })
  );
}

function collectPreviousNodes(
  nodes: readonly TaskChatToolCallTreeNode[],
  nodeById: Map<string, TaskChatToolCallTreeNode>,
) {
  for (const node of nodes) {
    nodeById.set(node.toolCall.toolId, node);
    collectPreviousNodes(node.childToolCalls, nodeById);
  }
}

function areNodeArraysEqual(
  left: readonly TaskChatToolCallTreeNode[],
  right: readonly TaskChatToolCallTreeNode[],
) {
  return left.length === right.length && left.every((node, index) => node === right[index]);
}

function finalizeToolCallTreeNode(
  draftNode: ToolCallTreeDraftNode,
  previousNodeById: Map<string, TaskChatToolCallTreeNode>,
): TaskChatToolCallTreeNode {
  const childToolCalls = draftNode.childToolCalls.map((child) =>
    finalizeToolCallTreeNode(child, previousNodeById),
  );
  const previousNode = previousNodeById.get(draftNode.toolCall.toolId);

  if (
    previousNode &&
    previousNode.toolCall === draftNode.toolCall &&
    areNodeArraysEqual(previousNode.childToolCalls, childToolCalls)
  ) {
    return previousNode;
  }

  return {
    toolCall: draftNode.toolCall,
    childToolCalls,
  };
}

export function buildToolCallTree(
  toolCalls: readonly TaskChatToolCall[] = [],
): TaskChatToolCallTreeNode[] {
  return reconcileToolCallTree(toolCalls);
}

export function reconcileToolCallTree(
  toolCalls: readonly TaskChatToolCall[] = [],
  previousTree: readonly TaskChatToolCallTreeNode[] = [],
): TaskChatToolCallTreeNode[] {
  const previousNodeById = new Map<string, TaskChatToolCallTreeNode>();
  collectPreviousNodes(previousTree, previousNodeById);

  const toolCallNodeById = new Map<string, ToolCallTreeDraftNode>();

  for (const toolCall of toolCalls) {
    const previousNode = previousNodeById.get(toolCall.toolId);
    toolCallNodeById.set(toolCall.toolId, {
      // 性能修复原因：streaming chunk 会让消息数组频繁重建，语义未变的 toolCall
      // 如果每轮都换引用，ToolCallBlock 的 memo 会被 childToolCalls 新数组击穿。
      toolCall:
        previousNode && areTaskChatToolCallsRenderEqual(previousNode.toolCall, toolCall)
          ? previousNode.toolCall
          : toolCall,
      childToolCalls: [],
    });
  }

  const rootToolCalls: ToolCallTreeDraftNode[] = [];
  for (const toolCall of toolCalls) {
    const node = toolCallNodeById.get(toolCall.toolId);
    if (!node) {
      continue;
    }

    const parentToolUseId = toolCall.parentToolUseId ?? null;
    const parentNode =
      parentToolUseId && parentToolUseId !== toolCall.toolId
        ? toolCallNodeById.get(parentToolUseId)
        : undefined;

    if (parentNode) {
      parentNode.childToolCalls.push(node);
    } else {
      // 子工具找不到父节点时回退到 root 平铺，避免异常 parent id 直接让工具消失。
      rootToolCalls.push(node);
    }
  }

  const nextTree = rootToolCalls.map((node) => finalizeToolCallTreeNode(node, previousNodeById));
  return areNodeArraysEqual(previousTree, nextTree)
    ? (previousTree as TaskChatToolCallTreeNode[])
    : nextTree;
}
