function description(opening: string, callingConvention: string, resultNote: string): string {
  return `${opening}

Deferred tools appear by name in <system-reminder> messages. Until fetched, only the name is known — there is no parameter schema, so the tool cannot be invoked. This tool takes a query, matches it against the deferred tool list, and returns the matched tools' complete JSONSchema definitions inside a <functions> block. ${callingConvention}

Result format: each matched tool appears as one <function>{"description": "...", "name": "...", "parameters": {...}}</function> line inside the <functions> block${resultNote}

Query forms:
- "select:Read,Edit,Grep" — fetch these exact tools by name
- "notebook jupyter" — keyword search, up to max_results best matches
- "+slack send" — require "slack" in the name, rank by remaining terms`;
}

export const NATIVE_TOOL_SEARCH_DESCRIPTION = description(
  "Fetches full schema definitions for deferred tools so they can be called.",
  "Once a tool's schema appears in that result, it is callable exactly like any tool defined at the top of the prompt.",
  " — the same encoding as the tool list at the top of this prompt.",
);

// Local 返回的定义描述目标参数，不能把它误读成已注册的直接调用入口。
export const LOCAL_TOOL_SEARCH_DESCRIPTION = `${description(
  "Fetches full schema definitions for deferred tools so they can be called using DeferredToolCall.",
  "Call deferred tools through DeferredToolCall with {name, input}. Call resident tools directly using their normal tool calls, even if their definitions were returned by direct selection.",
  ". For deferred tools, parameters describes the input object passed to DeferredToolCall.",
)}

Example (TodoWrite is deferred and already loaded):
<example>
DeferredToolCall({"name":"TodoWrite","input":{"todos":[{"content":"Inspect the implementation","status":"in_progress","priority":"high"}]}})
</example>`;
