import type {
  ZCodeConfigOption,
  ZCodePlanStep,
  ZCodeProvider,
  ZCodeTaskModeInfo,
} from "@zcode/shared";

interface PlanToolLike {
  title?: string;
  kind?: string;
  input?: unknown;
  output?: unknown;
  raw?: unknown;
}

interface ParsedPlanTool {
  summary: string | null;
  steps: ZCodePlanStep[];
  toolName: string | null;
}

interface ParsedPlanPayload {
  summary: string | null;
  steps: ZCodePlanStep[];
}

const PLAN_COLLECTION_KEYS = ["plan", "steps", "entries", "todos", "items"] as const;
const PLAN_TEXT_KEYS = ["explanation", "summary", "description", "planSummary"] as const;
const PLANISH_TOOL_PATTERNS = [
  /enter\s*_?plan\s*_?mode/i,
  /exit\s*_?plan\s*_?mode/i,
  /update\s*_?plan/i,
  /plan\s+mode/i,
  /switch\s*_?mode/i,
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }

    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  return null;
}

function normalizePlanStepStatus(value: unknown): ZCodePlanStep["status"] {
  if (typeof value !== "string") {
    return "pending";
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "completed" || normalized === "done") {
    return "completed";
  }

  if (normalized === "in_progress" || normalized === "in-progress" || normalized === "running") {
    return "in_progress";
  }

  return "pending";
}

function createPlanStep(title: string, status: unknown, index: number): ZCodePlanStep | null {
  const trimmedTitle = title.trim();
  if (trimmedTitle.length === 0) {
    return null;
  }

  return {
    id: `${index}-${trimmedTitle}`,
    title: trimmedTitle,
    status: normalizePlanStepStatus(status),
  };
}

function parsePlanMarkdown(markdown: string): ParsedPlanPayload | null {
  const trimmed = markdown.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const jsonPlan = extractPlanPayload(parsed);
      if (jsonPlan) {
        return jsonPlan;
      }
    } catch {
      // JSON 解析失败时继续按 markdown 文本处理。
    }
  }

  const lines = trimmed.split(/\r?\n/);
  const summaryLines: string[] = [];
  const steps: ZCodePlanStep[] = [];
  let encounteredList = false;

  for (const line of lines) {
    const current = line.trim();
    if (current.length === 0) {
      if (!encounteredList && summaryLines.at(-1) !== "") {
        summaryLines.push("");
      }
      continue;
    }

    const checkboxMatch = current.match(/^(?:[-*+]\s+)?\[( |x|X)\]\s+(.+)$/);
    if (checkboxMatch) {
      const checkboxState = checkboxMatch[1];
      const checkboxTitle = checkboxMatch[2];
      if (!checkboxState || !checkboxTitle) {
        continue;
      }

      encounteredList = true;
      const step = createPlanStep(
        checkboxTitle,
        checkboxState.toLowerCase() === "x" ? "completed" : "pending",
        steps.length,
      );
      if (step) {
        steps.push(step);
      }
      continue;
    }

    const listMatch = current.match(/^(?:[-*+]\s+|\d+\.\s+)(.+)$/);
    if (listMatch) {
      const listTitle = listMatch[1];
      if (!listTitle) {
        continue;
      }

      encounteredList = true;
      const step = createPlanStep(listTitle, "pending", steps.length);
      if (step) {
        steps.push(step);
      }
      continue;
    }

    if (!encounteredList) {
      summaryLines.push(current.replace(/^#+\s*/, ""));
    }
  }

  const summary = summaryLines.join("\n").trim() || null;
  if (steps.length === 0 && summary === null) {
    return null;
  }

  return {
    summary,
    steps,
  };
}

function parsePlanStepEntry(value: unknown, index: number): ZCodePlanStep | null {
  if (typeof value === "string") {
    return createPlanStep(value, "pending", index);
  }

  if (!isRecord(value)) {
    return null;
  }

  const title = firstNonEmptyString(value.step, value.title, value.content, value.text);
  if (!title) {
    return null;
  }

  return createPlanStep(title, value.status, index);
}

function pickBetterPlan(
  current: ParsedPlanPayload | null,
  next: ParsedPlanPayload | null,
): ParsedPlanPayload | null {
  if (!next) {
    return current;
  }

  if (!current) {
    return next;
  }

  if (next.steps.length > current.steps.length) {
    return next;
  }

  if (next.steps.length === current.steps.length && next.summary && !current.summary) {
    return next;
  }

  return current;
}

function extractPlanPayload(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
): ParsedPlanPayload | null {
  if (typeof value === "string") {
    return parsePlanMarkdown(value);
  }

  if (Array.isArray(value)) {
    const directSteps = value
      .map((entry, index) => parsePlanStepEntry(entry, index))
      .filter((step): step is ZCodePlanStep => step !== null);
    if (directSteps.length > 0) {
      return {
        summary: null,
        steps: directSteps,
      };
    }

    let best: ParsedPlanPayload | null = null;
    for (const entry of value) {
      best = pickBetterPlan(best, extractPlanPayload(entry, seen));
    }
    return best;
  }

  if (!isRecord(value)) {
    return null;
  }

  if (seen.has(value)) {
    return null;
  }
  seen.add(value);

  const singleStep = parsePlanStepEntry(value, 0);
  if (singleStep) {
    return {
      summary: null,
      steps: [singleStep],
    };
  }

  let best: ParsedPlanPayload | null = null;

  for (const key of PLAN_COLLECTION_KEYS) {
    best = pickBetterPlan(best, extractPlanPayload(value[key], seen));
  }

  if (isRecord(value.content) && value.content.type === "text") {
    best = pickBetterPlan(best, extractPlanPayload(value.content.text, seen));
  } else {
    best = pickBetterPlan(best, extractPlanPayload(value.content, seen));
  }

  best = pickBetterPlan(best, extractPlanPayload(value.rawInput, seen));
  best = pickBetterPlan(best, extractPlanPayload(value.rawOutput, seen));
  best = pickBetterPlan(best, extractPlanPayload(value.result, seen));

  const summary = firstNonEmptyString(...PLAN_TEXT_KEYS.map((key) => value[key]));
  if (best) {
    return {
      summary: best.summary ?? summary,
      steps: best.steps,
    };
  }

  if (typeof value.text === "string") {
    return parsePlanMarkdown(value.text);
  }

  if (summary) {
    return {
      summary,
      steps: [],
    };
  }

  return null;
}

function hasPlanStructuredKeys(value: unknown, seen: WeakSet<object> = new WeakSet()): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => hasPlanStructuredKeys(entry, seen));
  }

  if (!isRecord(value)) {
    return false;
  }

  if (seen.has(value)) {
    return false;
  }
  seen.add(value);

  if (PLAN_COLLECTION_KEYS.some((key) => key in value)) {
    return true;
  }

  return Object.values(value).some((entry) => hasPlanStructuredKeys(entry, seen));
}

function extractToolName(raw: unknown): string | null {
  if (!isRecord(raw)) {
    return null;
  }

  return firstNonEmptyString(raw.name, raw.toolName, raw.tool_name, raw.title);
}

export function getModeOptionFromConfigOptions(
  configOptions: ZCodeConfigOption[],
): ZCodeConfigOption | null {
  const modeOption = configOptions.find(
    (option) => option.category === "mode" && option.type === "select",
  );
  return modeOption ?? null;
}

export function getCurrentModeIdFromConfigOptions(
  configOptions: ZCodeConfigOption[],
): string | null {
  const modeOption = getModeOptionFromConfigOptions(configOptions);
  if (typeof modeOption?.currentValue !== "string") {
    return null;
  }
  const currentValue = modeOption.currentValue.trim();
  return currentValue.length > 0 ? currentValue : null;
}

/**
 * Resolve provider-native modeId from semantic modeId.
 * This is the UI counterpart of resolveProviderModeIdFromConfigOptions in service layer.
 *
 * @param configOptions - The config options array
 * @param semanticModeId - The semantic mode ID (e.g., "default", "plan")
 * @returns The provider-native mode ID, or the original semanticModeId if not found
 */
export function resolveProviderNativeModeIdFromSemantic(
  configOptions: ZCodeConfigOption[],
  semanticModeId: string,
  provider?: ZCodeProvider,
): string {
  const modeOption = getModeOptionFromConfigOptions(configOptions);
  if (!modeOption?.options) {
    return semanticModeId;
  }

  // Look for exact match first
  const exactMatch = modeOption.options.find((opt) => opt.value === semanticModeId);
  if (exactMatch) {
    return exactMatch.value;
  }

  // Try normalized mapping for known variants
  const normalizedMode = normalizeSessionMode(semanticModeId, provider);
  const normalizedMatch = modeOption.options.find((opt) => {
    const normalizedOpt = normalizeSessionMode(opt.value, provider);
    return normalizedOpt === normalizedMode;
  });

  return normalizedMatch?.value ?? semanticModeId;
}

function normalizeSessionMode(mode: string, _provider?: ZCodeProvider): string {
  const normalized = mode.trim().toLowerCase();
  // Map known provider-native variants to canonical forms
  switch (normalized) {
    case "default":
      return "default";
    case "full-access":
    case "full_access":
    case "bypasspermissions":
      return "bypassPermissions";
    case "read-only":
    case "read_only":
    case "plan":
      return "plan";
    case "guarded":
      return "guarded";
    // 修复原因：新增模式曾吸收旧 full-auto 别名；历史全权限语义仍必须是 YOLO。
    case "full-auto":
    case "full_auto":
    case "yolo":
      return "yolo";
    case "auto-edit":
    case "auto_edit":
    case "build":
      return "build";
    default:
      return normalized;
  }
}

export function getAvailableModesFromConfigOptions(
  configOptions: ZCodeConfigOption[],
): ZCodeTaskModeInfo[] {
  const modeOption = getModeOptionFromConfigOptions(configOptions);
  if (!modeOption?.options) {
    return [];
  }

  return modeOption.options.map((option) => ({
    id: option.value,
    name: option.name,
    description: option.description,
  }));
}

export function getModeLabelFromConfigOptions(
  configOptions: ZCodeConfigOption[],
  modeId: string | null,
): string | null {
  if (!modeId) {
    return null;
  }

  const modeOption = getModeOptionFromConfigOptions(configOptions);
  return modeOption?.options?.find((option) => option.value === modeId)?.name ?? modeId;
}

export function getPlanToolPayload(tool: PlanToolLike): ParsedPlanTool | null {
  const toolName = extractToolName(tool.raw);
  const toolFingerprint = [tool.title, tool.kind, toolName].filter(Boolean).join(" ");
  const isPlanishTool = PLANISH_TOOL_PATTERNS.some((pattern) => pattern.test(toolFingerprint));
  const hasStructuredPlan =
    hasPlanStructuredKeys(tool.input) ||
    hasPlanStructuredKeys(tool.output) ||
    hasPlanStructuredKeys(tool.raw);

  if (!isPlanishTool && !hasStructuredPlan) {
    return null;
  }

  const parsed = [tool.input, tool.output, tool.raw].reduce<ParsedPlanPayload | null>(
    (best, candidate) => pickBetterPlan(best, extractPlanPayload(candidate)),
    null,
  );
  if (!parsed) {
    return null;
  }

  if (parsed.steps.length === 0 && !hasStructuredPlan && !/plan/i.test(toolFingerprint)) {
    return null;
  }

  return {
    summary: parsed.summary,
    steps: parsed.steps,
    toolName,
  };
}
