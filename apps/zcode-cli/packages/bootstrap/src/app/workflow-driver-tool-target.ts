// ============================================================
// 工具调用 → 一条给人看的「目标」线索
// ============================================================
// `node-progress` 的 `lastTool.target` 回答的是「它正在动哪儿」：文件类工具给路径，Bash 给命令头，
// 搜索类给 pattern。它**不是入参**——入参可以装下一整个 patch、一段 base64、一份文件正文，而这条
// 事件会被主代理读进上下文、被 GUI 画在卡片上，所以只取一个有界的标量键，其余一律当作「认不出」。
//
// 按**键名**而不是按工具名认：工具名会变、MCP 工具的名字根本不在我们手里，而 `file_path` / `command`
// 这几个键名是本仓库工具入参的既成约定（contracts 的 read/edit/write/bash/glob/grep schema）。
// 认不出就缺席——合成一个「(unknown)」占位串只会让读者以为那是真的目标。

import {
  LAST_TOOL_NAME_MAX_CHARS,
  LAST_TOOL_TARGET_MAX_CHARS,
  type AskLastTool,
} from "@zcode/dynamic-workflow";

/**
 * 按优先级探测的入参键。命中第一个**非空字符串**即为目标；路径族保尾（文件名才是分辨点），
 * 其余保头（命令、pattern、url 的开头才是分辨点）。
 */
const TARGET_KEYS: readonly { key: string; keep: "head" | "tail" }[] = [
  { key: "file_path", keep: "tail" },
  { key: "notebook_path", keep: "tail" },
  { key: "path", keep: "tail" },
  { key: "command", keep: "head" },
  { key: "pattern", keep: "head" },
  { key: "url", keep: "head" },
  { key: "query", keep: "head" },
];

/** 省略号标记（保尾时前置）：读者要能看出这条线索被截过。 */
const ELLIPSIS = "…";

/** 一次工具调用的窄视图：名字 + 入参。两者都可能缺席（老事件、空名调用）。 */
export interface ToolCallSummaryInput {
  toolName?: string;
  input?: unknown;
}

/**
 * 把一次工具调用压成 `lastTool`。名字缺席即整条缺席——一个没有名字的「最近工具」什么也没说。
 */
export function summarizeToolCall(call: ToolCallSummaryInput): AskLastTool | undefined {
  const name = typeof call.toolName === "string" ? call.toolName.trim() : "";
  if (name.length === 0) return undefined;
  const target = deriveToolTarget(call.input);
  return {
    name: name.slice(0, LAST_TOOL_NAME_MAX_CHARS),
    ...(target === undefined ? {} : { target }),
  };
}

/** 从入参里取目标线索；不是对象、没有已知键、或该键不是非空字符串时缺席。 */
export function deriveToolTarget(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  for (const { key, keep } of TARGET_KEYS) {
    const value = record[key];
    if (typeof value !== "string") continue;
    // 多行命令只取第一行并压掉连续空白：命令头才是「在跑什么」，整段 heredoc 不是。
    const flattened = value.split("\n", 1)[0]!.replace(/\s+/g, " ").trim();
    if (flattened.length === 0) continue;
    return bound(flattened, keep);
  }
  return undefined;
}

/** 截到 {@link LAST_TOOL_TARGET_MAX_CHARS}：保头直接切，保尾前置省略号后切。 */
function bound(text: string, keep: "head" | "tail"): string {
  if (text.length <= LAST_TOOL_TARGET_MAX_CHARS) return text;
  if (keep === "head") return text.slice(0, LAST_TOOL_TARGET_MAX_CHARS);
  return ELLIPSIS + text.slice(text.length - (LAST_TOOL_TARGET_MAX_CHARS - ELLIPSIS.length));
}
