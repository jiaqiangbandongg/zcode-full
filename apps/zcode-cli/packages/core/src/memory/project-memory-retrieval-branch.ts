export type ProjectMemoryRetrievalBranch = "default-index" | "semantic-recall";

// 当前默认检索分支关闭 Semantic Recall；未来切换只修改这一处值。
const PROJECT_MEMORY_SEMANTIC_RECALL_ENABLED = false;

export function resolveProjectMemoryRetrievalBranch(
  semanticRecallEnabled: boolean,
): ProjectMemoryRetrievalBranch {
  return semanticRecallEnabled ? "semantic-recall" : "default-index";
}

export const ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH = resolveProjectMemoryRetrievalBranch(
  PROJECT_MEMORY_SEMANTIC_RECALL_ENABLED,
);
