/**
 * 假 provider 服务器的 wire 帧（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Verification」）：Anthropic
 * Messages 与 OpenAI chat completions 两套成功帧 / 流内错误帧 / 业务错误体。故障层与格式无关，
 * 只有这里分两套；写法参考 adapters/tests/model-execution.test.ts 的 `sseFrame`（家规不跨包引用
 * 测试树，所以重写一遍）。
 */

import { SUBMIT_RESULT_TOOL_NAME } from "@zcode/contracts";

export type WireFormat = "anthropic-messages" | "openai-chat-completions";

export interface CannedModelOptions {
  /** K：每个子代理的空转轮数，缺省 3。 */
  turns?: number;
  /** submit_result 的 payload，缺省 `{ note: "done" }`。 */
  submitPayload?: unknown;
  /** 「可见输出」帧里的文本，缺省 "Working."。 */
  visibleText?: string;
}

const DEFAULT_CANNED_TURNS = 3;
const DEFAULT_SUBMIT_PAYLOAD: { note: string } = { note: "done" };
const CANNED_GLOB_INPUT: { pattern: string } = { pattern: "**/*.md" };
export const DEFAULT_VISIBLE_TEXT = "Working.";
const MODEL_NAME = "alpha";
const USAGE_IN = 12;
const USAGE_OUT = 8;

export const SSE_HEADERS = {
  "cache-control": "no-cache",
  "content-type": "text/event-stream; charset=utf-8",
} as const;

interface CannedTurn {
  toolName: string;
  toolInput: unknown;
  toolCallId: string;
}

/** 罐头模型：对话进度 → 这一轮该发哪个工具调用。纯函数。 */
export function cannedTurn(toolResultCount: number, options: CannedModelOptions): CannedTurn {
  const turns = options.turns ?? DEFAULT_CANNED_TURNS;
  if (toolResultCount < turns) {
    return {
      toolName: "Glob",
      toolInput: CANNED_GLOB_INPUT,
      toolCallId: `call-glob-${toolResultCount + 1}`,
    };
  }
  return {
    toolName: SUBMIT_RESULT_TOOL_NAME,
    toolInput: { result: options.submitPayload ?? DEFAULT_SUBMIT_PAYLOAD },
    toolCallId: `call-submit-${toolResultCount + 1}`,
  };
}

function sseFrame(event: string | undefined, data: unknown): string {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  return event === undefined ? `data: ${payload}\n\n` : `event: ${event}\ndata: ${payload}\n\n`;
}

// ————————————————————————————————————————————————————————————————
// Anthropic Messages
// ————————————————————————————————————————————————————————————————

/** Anthropic 流的首帧（message_start）：没有任何可见输出。 */
function anthropicMessageStart(ordinal: number): string {
  return sseFrame("message_start", {
    type: "message_start",
    message: {
      id: `msg_${ordinal}`,
      type: "message",
      role: "assistant",
      model: MODEL_NAME,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: USAGE_IN, output_tokens: 0 },
    },
  });
}

/** Anthropic 流的可见文本块（三帧）。 */
function anthropicVisibleText(index: number, text: string): string {
  return [
    sseFrame("content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "" },
    }),
    sseFrame("content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text },
    }),
    sseFrame("content_block_stop", { type: "content_block_stop", index }),
  ].join("");
}

/** Anthropic 流的工具调用块 + 收尾（input 拆成两个 delta，逼真一点）。 */
function anthropicToolUseFrames(index: number, turn: CannedTurn): string {
  const json = JSON.stringify(turn.toolInput);
  const half = Math.ceil(json.length / 2);
  return [
    sseFrame("content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id: turn.toolCallId, name: turn.toolName, input: {} },
    }),
    sseFrame("content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: json.slice(0, half) },
    }),
    sseFrame("content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: json.slice(half) },
    }),
    sseFrame("content_block_stop", { type: "content_block_stop", index }),
    sseFrame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: USAGE_OUT },
    }),
    sseFrame("message_stop", { type: "message_stop" }),
  ].join("");
}

function anthropicNonStreamBody(ordinal: number, turn: CannedTurn): unknown {
  return {
    id: `msg_${ordinal}`,
    type: "message",
    role: "assistant",
    model: MODEL_NAME,
    content: [{ type: "tool_use", id: turn.toolCallId, name: turn.toolName, input: turn.toolInput }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: USAGE_IN, output_tokens: USAGE_OUT },
  };
}

// ————————————————————————————————————————————————————————————————
// OpenAI chat completions
// ————————————————————————————————————————————————————————————————

function openaiChunk(
  ordinal: number,
  choice: Record<string, unknown> | undefined,
  extra?: Record<string, unknown>,
): string {
  return sseFrame(undefined, {
    id: `chatcmpl-${ordinal}`,
    object: "chat.completion.chunk",
    created: 1,
    model: MODEL_NAME,
    choices: choice === undefined ? [] : [{ index: 0, finish_reason: null, ...choice }],
    ...extra,
  });
}

/** OpenAI 流的首帧（只带 role，没有任何可见内容）。 */
function openaiRoleChunk(ordinal: number): string {
  return openaiChunk(ordinal, { delta: { role: "assistant", content: "" } });
}

function openaiVisibleChunk(ordinal: number, text: string): string {
  return openaiChunk(ordinal, { delta: { content: text } });
}

/** OpenAI 流的工具调用块 + finish + usage + [DONE]。 */
function openaiToolCallFrames(ordinal: number, turn: CannedTurn): string {
  const json = JSON.stringify(turn.toolInput);
  const half = Math.ceil(json.length / 2);
  return [
    openaiChunk(ordinal, {
      delta: {
        tool_calls: [
          {
            index: 0,
            id: turn.toolCallId,
            type: "function",
            function: { name: turn.toolName, arguments: json.slice(0, half) },
          },
        ],
      },
    }),
    openaiChunk(ordinal, {
      delta: { tool_calls: [{ index: 0, function: { arguments: json.slice(half) } }] },
    }),
    openaiChunk(ordinal, { delta: {}, finish_reason: "tool_calls" }),
    openaiChunk(ordinal, undefined, {
      usage: { prompt_tokens: USAGE_IN, completion_tokens: USAGE_OUT, total_tokens: USAGE_IN + USAGE_OUT },
    }),
    "data: [DONE]\n\n",
  ].join("");
}

function openaiNonStreamBody(ordinal: number, turn: CannedTurn): unknown {
  return {
    id: `chatcmpl-${ordinal}`,
    object: "chat.completion",
    created: 1,
    model: MODEL_NAME,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: turn.toolCallId,
              type: "function",
              function: { name: turn.toolName, arguments: JSON.stringify(turn.toolInput) },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: USAGE_IN, completion_tokens: USAGE_OUT, total_tokens: USAGE_IN + USAGE_OUT },
  };
}

// ————————————————————————————————————————————————————————————————
// 与格式相关的错误体
// ————————————————————————————————————————————————————————————————

/** 两种 wire 共用的首帧：有 message_start / role 帧但还没有任何可见输出。 */
export function firstFrame(route: WireFormat, ordinal: number): string {
  return route === "anthropic-messages" ? anthropicMessageStart(ordinal) : openaiRoleChunk(ordinal);
}

export function visibleFrame(route: WireFormat, ordinal: number, text: string): string {
  return route === "anthropic-messages" ? anthropicVisibleText(0, text) : openaiVisibleChunk(ordinal, text);
}

export function successStream(route: WireFormat, ordinal: number, turn: CannedTurn): string {
  return route === "anthropic-messages"
    ? anthropicMessageStart(ordinal) + anthropicToolUseFrames(0, turn)
    : openaiRoleChunk(ordinal) + openaiToolCallFrames(ordinal, turn);
}

export function successBody(route: WireFormat, ordinal: number, turn: CannedTurn): string {
  return JSON.stringify(
    route === "anthropic-messages" ? anthropicNonStreamBody(ordinal, turn) : openaiNonStreamBody(ordinal, turn),
  );
}

/**
 * 流内错误帧：两种 wire 都把 code 放在 `error.code`——这是 `readProviderBusinessFailureFromBody`
 * 的 error.code 分支（model-execution.ts），SSE 帧解析器复用同一函数，所以 providerCode 一定落到。
 */
export function streamErrorFrame(route: WireFormat, code: string, message: string): string {
  if (route === "anthropic-messages") {
    return sseFrame("error", {
      type: "error",
      error: { type: "rate_limit_error", code, message },
    });
  }
  return sseFrame(undefined, { error: { code, message } });
}

/** 非 2xx 的业务错误体：`error-object`（BigModel 两种端点共同的形状）或 Start Plan 网关的 `top-level`。 */
export function businessErrorBody(verdict: {
  status: number;
  code?: string;
  message?: string;
  bodyShape?: "error-object" | "top-level";
}): string {
  const message = verdict.message ?? `fake provider status ${verdict.status}`;
  if (verdict.bodyShape === "top-level") {
    return JSON.stringify({
      ...(verdict.code === undefined ? {} : { code: Number(verdict.code) }),
      msg: message,
    });
  }
  return JSON.stringify({
    error: {
      ...(verdict.code === undefined ? {} : { code: verdict.code }),
      message,
      type: "error",
    },
  });
}
