import type { UserInputQuestionPayload } from "@zcode/shared/zcode-protocol-v4";

/**
 * MCP elicitation（server → client `elicitation/create`）与 ZCode 用户提问通道的映射
 * 。纯函数：requestedSchema → 问题列表，
 * 用户答案 → ElicitResult.content。broker 与 product-projection 共用，保证 live/v4 两条路径一致。
 */

/** 合成 PermissionRequested 事件里用的工具名哨兵；projection 与 renderer 据此识别。 */
export const MCP_ELICITATION_TOOL_NAME = "McpElicitation";
export const MCP_ELICITATION_INTERACTION = "mcp_elicitation";
/** 自由文本题目在旧 userInput 通道里必须至少有一个选项；用这个哨兵值表示"请输入"。 */
export const MCP_ELICITATION_FREE_TEXT_OPTION = "__zcode_free_text__";

export interface McpElicitationSchemaField {
  name: string;
  type: "string" | "number" | "integer" | "boolean" | "enum";
  title?: string;
  description?: string;
  enumValues?: string[];
  enumNames?: string[];
  required: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 解析 MCP `requestedSchema`（扁平 object，属性只允许原始类型）；非法属性跳过。 */
export function readMcpElicitationFields(requestedSchema: unknown): McpElicitationSchemaField[] {
  if (!isRecord(requestedSchema) || !isRecord(requestedSchema.properties)) return [];
  const required = new Set(
    Array.isArray(requestedSchema.required)
      ? requestedSchema.required.filter((item): item is string => typeof item === "string")
      : [],
  );
  const fields: McpElicitationSchemaField[] = [];
  for (const [name, raw] of Object.entries(requestedSchema.properties)) {
    if (!isRecord(raw)) continue;
    const enumValues = Array.isArray(raw.enum)
      ? raw.enum.filter((item): item is string => typeof item === "string")
      : undefined;
    const type = enumValues
      ? "enum"
      : raw.type === "number" || raw.type === "integer" || raw.type === "boolean"
        ? raw.type
        : raw.type === "string"
          ? "string"
          : null;
    if (!type) continue;
    fields.push({
      name,
      type,
      ...(typeof raw.title === "string" ? { title: raw.title } : {}),
      ...(typeof raw.description === "string" ? { description: raw.description } : {}),
      ...(enumValues ? { enumValues } : {}),
      ...(Array.isArray(raw.enumNames)
        ? { enumNames: raw.enumNames.filter((item): item is string => typeof item === "string") }
        : {}),
      required: required.has(name),
    });
  }
  return fields;
}

/** 字段 → 用户提问；string/number 用自由文本哨兵选项，boolean 用 Yes/No，enum 用枚举值。 */
export function mcpElicitationQuestions(
  message: string,
  requestedSchema: unknown,
): UserInputQuestionPayload[] {
  const fields = readMcpElicitationFields(requestedSchema);
  if (fields.length === 0) {
    return [
      {
        header: "Answer",
        question: message,
        options: [{ value: MCP_ELICITATION_FREE_TEXT_OPTION, label: "Type your answer" }],
      },
    ];
  }
  return fields.map((field) => {
    const header = field.title ?? field.name;
    const question = field.description ?? `${message}\n\n${header}`;
    if (field.type === "boolean") {
      return { header, question, options: [{ value: "true", label: "Yes" }, { value: "false", label: "No" }] };
    }
    if (field.type === "enum" && field.enumValues && field.enumValues.length > 0) {
      return {
        header,
        question,
        options: field.enumValues.map((value, index) => ({
          value,
          label: field.enumNames?.[index] ?? value,
        })),
      };
    }
    return {
      header,
      question,
      options: [{ value: MCP_ELICITATION_FREE_TEXT_OPTION, label: "Type your answer" }],
    };
  });
}

function readAnswer(content: Record<string, unknown>, index: number, question: string): unknown {
  const indexed = content[`answer_${index}`];
  if (indexed !== undefined) return indexed;
  const answers = content.answers;
  if (isRecord(answers)) return answers[question];
  if (index === 0 && content.answer !== undefined) return content.answer;
  return undefined;
}

function firstString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

/** 用户答案 → MCP ElicitResult.content；按 requestedSchema 类型收敛，无法收敛的字段省略。 */
export function mcpElicitationContentFromAnswers(
  requestedSchema: unknown,
  questions: UserInputQuestionPayload[],
  content: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!content) return {};
  const fields = readMcpElicitationFields(requestedSchema);
  const result: Record<string, unknown> = {};
  fields.forEach((field, index) => {
    const raw = firstString(readAnswer(content, index, questions[index]?.question ?? ""));
    if (raw === undefined || raw === MCP_ELICITATION_FREE_TEXT_OPTION) return;
    switch (field.type) {
      case "boolean":
        result[field.name] = raw === "true" || raw.toLowerCase() === "yes";
        return;
      case "number":
      case "integer": {
        const parsed = Number(raw);
        if (Number.isFinite(parsed)) result[field.name] = field.type === "integer" ? Math.trunc(parsed) : parsed;
        return;
      }
      default:
        result[field.name] = raw;
    }
  });
  if (fields.length === 0) {
    const raw = firstString(readAnswer(content, 0, questions[0]?.question ?? ""));
    if (raw !== undefined && raw !== MCP_ELICITATION_FREE_TEXT_OPTION) result.answer = raw;
  }
  return result;
}
