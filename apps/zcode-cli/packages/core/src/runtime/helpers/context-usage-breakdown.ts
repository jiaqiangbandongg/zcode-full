import type {
  ContextUsageCategory,
  ContextUsageMetric,
  ContextUsageMessageRoleBreakdown,
  ContextUsageSkillDetail,
  ContextUsageToolDetail,
} from "../types.js";

type ContextUsageContributorKind = "context_section" | "tool_schema" | "skill" | "message_role";

export interface ContextUsageContributor extends ContextUsageMetric {
  cacheHint?: string;
  categorySource: ContextUsageCategory["source"];
  count?: number;
  injectionTarget?: string;
  kind: ContextUsageContributorKind;
  label: string;
  name?: string;
  path?: string;
  readOnly?: boolean;
  role?: string;
  scope?: string;
  serverName?: string;
  sideEffectScope?: string;
  source?: string;
}

export interface ContextUsageCategoryBreakdown extends ContextUsageCategory {
  contributors: ContextUsageContributor[];
}

export type ContextUsageSectionDetail = ContextUsageMetric & {
  cacheHint: string;
  injectionTarget: string;
  name: string;
  source: string;
};

export function buildCategoryBreakdown(
  categoryBySource: ReadonlyMap<ContextUsageCategory["source"], ContextUsageCategory>,
  source: ContextUsageCategory["source"],
  contributors: ContextUsageContributor[],
): ContextUsageCategoryBreakdown | undefined {
  const category = categoryBySource.get(source);
  if (!category) return undefined;
  return {
    ...category,
    contributors,
  };
}

export function sectionContributor(
  categorySource: ContextUsageCategory["source"],
  section: ContextUsageSectionDetail,
): ContextUsageContributor {
  return {
    kind: "context_section",
    categorySource,
    label: section.name,
    name: section.name,
    source: section.source,
    injectionTarget: section.injectionTarget,
    cacheHint: section.cacheHint,
    chars: section.chars,
    tokens: section.tokens,
    tokenMethod: section.tokenMethod,
    confidence: section.confidence,
    tokenizer: section.tokenizer,
  };
}

export function toolContributor(
  categorySource: ContextUsageCategory["source"],
  tool: ContextUsageToolDetail,
): ContextUsageContributor {
  return {
    kind: "tool_schema",
    categorySource,
    label: tool.name,
    name: tool.name,
    source: tool.source,
    serverName: tool.serverName,
    readOnly: tool.readOnly,
    sideEffectScope: tool.sideEffectScope,
    chars: tool.chars,
    tokens: tool.tokens,
    tokenMethod: tool.tokenMethod,
    confidence: tool.confidence,
    tokenizer: tool.tokenizer,
  };
}

export function skillContributor(
  categorySource: ContextUsageCategory["source"],
  skill: ContextUsageSkillDetail,
): ContextUsageContributor {
  return {
    kind: "skill",
    categorySource,
    label: skill.name,
    name: skill.name,
    source: skill.source,
    scope: skill.scope,
    path: skill.path,
    chars: skill.chars,
    tokens: skill.tokens,
    tokenMethod: skill.tokenMethod,
    confidence: skill.confidence,
    tokenizer: skill.tokenizer,
  };
}

export function messageRoleContributor(
  message: ContextUsageMessageRoleBreakdown,
): ContextUsageContributor {
  return {
    kind: "message_role",
    categorySource: "messages",
    label: message.role,
    role: message.role,
    count: message.count,
    chars: message.chars,
    tokens: message.tokens,
    tokenMethod: message.tokenMethod,
    confidence: message.confidence,
    tokenizer: message.tokenizer,
  };
}
