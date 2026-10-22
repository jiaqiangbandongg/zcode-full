import { DEFERRED_TOOL_CALL_NAME, type ModelToolContract } from "@zcode/contracts";
import { wrapSystemReminderForSource } from "../../system-reminder/source.js";

// 编码只在本次请求内复用；下一请求必须读取当前定义，不能跨请求留下过期 schema。
export function createLocalToolDefinitionRenderer(): (tool: ModelToolContract) => string {
  const definitions = new Map<ModelToolContract, string>();
  return (tool) => {
    let definition = definitions.get(tool);
    if (definition === undefined) {
      definition = `<function>${JSON.stringify({ description: tool.description ?? "", name: tool.name, parameters: tool.inputSchema })}</function>`;
      definitions.set(tool, definition);
    }
    return definition;
  };
}

export function localToolsAlreadyLoadedReminder(names: readonly string[]): string {
  // 指引属于当前工具结果，内联包装即可；不作为 attachment 参与 MCS 重排。
  return wrapSystemReminderForSource(
    "tool_result_warning",
    `Tool definitions already available in this conversation: ${names.join(", ")}. Use ${DEFERRED_TOOL_CALL_NAME} with {name, input} to execute these tools. Searching again does not execute them.`,
  );
}

export function localToolsLoadedReminder(names: readonly string[]): string {
  const action = names.length === 1 ? "Call it now" : "Call them now";
  return wrapSystemReminderForSource(
    "tool_result_warning",
    `Loaded: ${names.join(", ")}. ${action} with ${DEFERRED_TOOL_CALL_NAME} {"name":"<tool name>","input":{...}}, using the exact tool name and filling input according to its schema above. No additional ToolSearch is needed before calling these tools.`,
  );
}
