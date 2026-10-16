/** 持久化目录增量；恢复只信结构化数据，不从自然语言正文推断已通知类型。 */
export interface AgentListingDelta {
  addedTypes: string[];
  addedLines: string[];
  removedTypes: string[];
  isInitial: boolean;
  showConcurrencyNote: boolean;
}

export function parseAgentListingDelta(value: unknown): AgentListingDelta | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const { addedTypes, addedLines, removedTypes, isInitial, showConcurrencyNote } = value as Record<
    string,
    unknown
  >;
  if (
    !isStringArray(addedTypes) ||
    !isStringArray(addedLines) ||
    !isStringArray(removedTypes) ||
    typeof isInitial !== "boolean" ||
    typeof showConcurrencyNote !== "boolean" ||
    addedTypes.length !== addedLines.length ||
    new Set(addedTypes).size !== addedTypes.length ||
    new Set(removedTypes).size !== removedTypes.length ||
    addedTypes.some((name) => removedTypes.includes(name))
  )
    return undefined;
  return {
    addedTypes: [...addedTypes],
    addedLines: [...addedLines],
    removedTypes: [...removedTypes],
    isInitial: isInitial,
    showConcurrencyNote: showConcurrencyNote,
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
