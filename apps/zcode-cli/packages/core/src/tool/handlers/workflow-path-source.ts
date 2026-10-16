// ============================================================
// `path` 来源：把一个磁盘上的脚本文件读成执行事实
// ============================================================
//
// 四个工具共用这一段（`CreateWorkflow.path`、`AmendWorkflow.path`、`SaveWorkflow.script_path`、
// `EvalWorkflowSnippet.path`）。共用的理由不是省几行：它们对「这个文件是什么」必须给出同一个
// 答案，否则同一份草稿在 Create 里是「带元数据块的保存定义」、在 Save 里却成了「正文第一行是
// 一段注释」的脚本——而那种分叉只会在用户把草稿存成定义的那一次才被发现。
//
// 读一次、只读一次：读出来的字节此后一路带到 hook、确认窗与 handler（`resolveInput` 的契约），
// 批准之后再改文件也改不了将要执行的东西。

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { SavedWorkflowMeta } from "@zcode/contracts";
import { SAVED_WORKFLOW_SENTINEL, parseSavedWorkflow } from "./saved-workflows/index.js";
import { describeWorkflowScriptPath } from "./workflow-script-path.js";

/** 读成功的脚本文件。 */
export interface WorkflowScriptFile {
  /** 绝对路径（journal 与模型面各取所需：前者存它，后者显示 {@link described}）。 */
  path: string;
  /** 模型面该看到的写法：工作区之下给相对路径，否则绝对路径。 */
  described: string;
  /** 文件原文，逐字节。 */
  source: string;
  /** 要执行 / 要保存的那一段：有元数据块时是正文，没有时就是整个文件。 */
  script: string;
  /** 元数据块解析出来的声明；文件没有块时缺席。 */
  meta?: SavedWorkflowMeta;
  /** 正文之前的行数（无块即 0）；诊断按文件行报出来时加它。 */
  bodyLineOffset: number;
}

export type WorkflowScriptFileResult =
  | { ok: true; file: WorkflowScriptFile }
  | { ok: false; message: string };

/**
 * 相对路径按会话工作目录解析，绝对路径原样归一——与 `Read` 收下一个路径的规则同一条
 * （core/src/tool/path-policy.ts 的 `resolveWorkspacePath`）。
 *
 * 这里没有走那个 helper：它要求一个 `workspaceRoot`，而 `resolveInput` 的上下文
 * （`ToolInputResolutionContext`）刻意窄到只有 `workingDirectory`。两者在 `operation: "read"`
 * 上的行为本就相同——那个函数当前不硬拦工作区之外的路径，只做同一条 resolve/normalize。
 */
export function resolveWorkflowScriptFilePath(cwd: string, inputPath: string): string {
  return path.isAbsolute(inputPath) ? path.normalize(inputPath) : path.resolve(cwd, inputPath);
}

/**
 * 读一个脚本文件。读不出来、或元数据块坏了，都回**点名文件**的结构化失败文案——不点名的话
 * 模型只会以为是自己刚写错了什么，然后原样重试一遍。
 *
 * `parseFrontmatter: false` 用于 `EvalWorkflowSnippet`：片段没有保存定义那套语义，整个文件
 * 就是代码，一段恰好以 `/* zcode-workflow` 开头的片段也不该被当成声明块吞掉。
 */
export async function readWorkflowScriptFile(options: {
  cwd: string;
  inputPath: string;
  parseFrontmatter?: boolean;
}): Promise<WorkflowScriptFileResult> {
  const absolute = resolveWorkflowScriptFilePath(options.cwd, options.inputPath);
  const described = describeWorkflowScriptPath(absolute, options.cwd);

  let source: string;
  try {
    source = await readFile(absolute, "utf8");
  } catch (error) {
    return {
      ok: false,
      message: `The workflow script file ${described} could not be read: ${describeError(error)}. Pass \`path\` for a file that exists, or submit the script inline.`,
    };
  }

  const base = { path: absolute, described, source };
  if (options.parseFrontmatter === false || !startsWithSentinel(source)) {
    return { ok: true, file: { ...base, script: source, bodyLineOffset: 0 } };
  }

  const parsed = parseSavedWorkflow(source);
  if (!parsed.ok) {
    return {
      ok: false,
      message: `The workflow script file ${described} starts with a \`${SAVED_WORKFLOW_SENTINEL}\` metadata block that could not be read (${parsed.reason}): ${parsed.detail}. Fix the block in that file, or remove it and pass the script alone.`,
    };
  }
  return {
    ok: true,
    file: {
      ...base,
      script: parsed.script,
      meta: parsed.meta,
      bodyLineOffset: parsed.bodyLineOffset,
    },
  };
}

/**
 * 首个非空行是不是起始标记。判据与 {@link parseSavedWorkflow} 自己的入口逐字一致——两处对
 * 「这是不是一个保存定义」给出不同答案，就会出现「工具说没有块、解析器说块坏了」的死角。
 */
function startsWithSentinel(source: string): boolean {
  for (const line of source.split("\n")) {
    if (line.trim() === "") continue;
    return line.trim() === SAVED_WORKFLOW_SENTINEL;
  }
  return false;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
