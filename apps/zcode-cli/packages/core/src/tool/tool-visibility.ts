export function normalizeToolNameAlias(toolName: string): string {
  return toolName === "web_search" ? "WebSearch" : toolName;
}

export function getToolRuleName(rule: string): string {
  const trimmed = rule.trim();
  const parenIndex = trimmed.indexOf("(");
  const rawName = parenIndex > 0 ? trimmed.slice(0, parenIndex) : trimmed;
  return normalizeToolNameAlias(rawName);
}

export function createToolRuleNameSet(
  rules: readonly string[] | undefined,
): ReadonlySet<string> | undefined {
  if (!rules || rules.length === 0) return undefined;
  const names = new Set<string>();
  for (const rule of rules) {
    const name = getToolRuleName(rule);
    if (name) names.add(name);
  }
  return names.size > 0 ? names : undefined;
}

export function isToolNameDisallowed(
  toolName: string,
  disallowedTools: readonly string[] | undefined,
): boolean {
  const disallowed = createToolRuleNameSet(disallowedTools);
  return disallowed?.has(normalizeToolNameAlias(toolName)) === true;
}

export function filterDisallowedToolNames(
  toolNames: readonly string[],
  disallowedTools: readonly string[] | undefined,
): readonly string[] {
  const disallowed = createToolRuleNameSet(disallowedTools);
  if (!disallowed) return toolNames;
  return toolNames.filter((toolName) => !disallowed.has(normalizeToolNameAlias(toolName)));
}
