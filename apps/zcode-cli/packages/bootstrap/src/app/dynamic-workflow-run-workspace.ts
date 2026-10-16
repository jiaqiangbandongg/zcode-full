// ============================================================
// 工作区 transcript 的读面（DynamicWorkflowRunPort 的两个 workspace 方法的实现体）
// ============================================================
//
// 一个 run 的 `files.*` / `git.*` / `world.run` 调用在 journal 里是 `kind ∈ {world-read,
// world-run}` 的 `dwf_node` 行：`input_json`（迁移 0030）是 op 与实参，`result_json` 是正文。
// UI 把它们回放成工具卡片——清单（不带正文）先来，正文展开时才取。
//
// 从 dynamic-workflow-run-service.ts 拆出（那个文件已在 max-lines 的既有欠账里），与产物的
// artifact-read.ts 同一条理由。
//
// **授权链**（与 readArtifact 同一条纪律，两条查询都走）：
//
//   调用方给的 runId
//        ├─① dwf_run 行存在吗？                              否 ⇒ undefined
//        ├─② 该行的 parent_session_id == 本服务的父会话吗？   否 ⇒ undefined
//        └─③ 才碰节点行
//
// 清单也授权而不只正文：`files.read` 的正文是工作区文件内容，而清单上的 args 已经是路径与
// 命令行——两者对「不是你的 run」都不该放行。三种拒绝归一成 undefined（网关归一成空清单 /
// not found），不告诉一个越权的调用方它猜对了哪一半。

import type { DwfRunIntrospectionQueries, DwfWorldNodeRow } from "@zcode/adapters/storage";
import type {
  DynamicWorkflowRunError,
  DynamicWorkflowRunWorkspaceNode,
  DynamicWorkflowRunWorkspaceNodeResult,
  DynamicWorkflowRunWorkspaceNodeResultQuery,
  DynamicWorkflowRunWorkspaceNodeSummary,
} from "@zcode/contracts";
import type { JournalStorePort, NodeRecord } from "@zcode/dynamic-workflow";

/** 失败信息的展示长度（= 协议侧 `WORKFLOW_WORKSPACE_LIMITS.maxErrorMessageLength`）。 */
const ERROR_MESSAGE_MAX_CHARS = 2000;

/**
 * 带工作区读面的 journal。签名的唯一来源是 adapters 的 {@link DwfRunIntrospectionQueries}
 * （`import type`，运行时零依赖）——与产物读面同一条论证：`listWorldNodes` 不在引擎的
 * {@link JournalStorePort} 上（引擎从不按 kind 枚举节点），只能靠能力探测接上。
 */
interface WorkspaceReadableJournal
  extends JournalStorePort, Pick<DwfRunIntrospectionQueries, "listWorldNodes"> {}

/** journal 是否带工作区读面。刻意是 `supportsArtifactReads` 的兄弟而不是把它扩宽（同一条论证）。 */
export function supportsWorkspaceReads(
  journal: JournalStorePort,
): journal is WorkspaceReadableJournal {
  return typeof (journal as Partial<DwfRunIntrospectionQueries>).listWorldNodes === "function";
}

interface WorkflowWorkspaceReadDeps {
  journal: JournalStorePort;
  /** 本服务的父会话（= 本 app 的会话）。授权链第 ② 步的比对对象。 */
  parentSessionId: string;
}

/** 授权链 ①②。`getRun` 在引擎端口上，不需要内省能力探测。 */
function authorizeRun(deps: WorkflowWorkspaceReadDeps, runId: string): boolean {
  const run = deps.journal.getRun(runId);
  if (run === undefined) return false;
  // parent_session_id 为 NULL 的老行**不放行**：「无从判定」不是「判定通过」。
  return run.parentSessionId !== undefined && run.parentSessionId === deps.parentSessionId;
}

/** 工作区 transcript 的清单：world 行按落库先后，不带正文。 */
export async function listWorkspaceNodesFrom(
  deps: WorkflowWorkspaceReadDeps,
  runId: string,
): Promise<readonly DynamicWorkflowRunWorkspaceNode[] | undefined> {
  if (!supportsWorkspaceReads(deps.journal)) return undefined;
  if (!authorizeRun(deps, runId)) return undefined;
  return deps.journal.listWorldNodes(runId).map(toWorkspaceNode);
}

function toWorkspaceNode(row: DwfWorldNodeRow): DynamicWorkflowRunWorkspaceNode {
  const summary = summaryOf(row);
  return {
    siteId: row.siteId,
    ordinal: row.ordinal,
    kind: row.kind === "world-run" ? "world-run" : "world-read",
    ...(row.input === undefined
      ? {}
      : {
          op: row.input.op,
          args: row.input.args,
          ...(row.input.truncated === true ? { inputTruncated: true as const } : {}),
        }),
    status: row.status,
    ...(row.error === undefined ? {} : { error: toRunError(row.error) }),
    ...(summary === undefined ? {} : { summary }),
    createdAt: row.timeCreated,
    updatedAt: row.timeUpdated,
  };
}

/** 存储层在库内算好的摘要 → 端口形状；只有结算成功（有正文）的行才有。 */
function summaryOf(row: DwfWorldNodeRow): DynamicWorkflowRunWorkspaceNodeSummary | undefined {
  if (row.status !== "completed" || row.resultBytes === undefined) return undefined;
  return {
    resultBytes: row.resultBytes,
    ...(row.resultCount === undefined ? {} : { resultCount: row.resultCount }),
    ...(row.exitCode === undefined ? {} : { exitCode: row.exitCode }),
    ...(row.stdoutBytes === undefined ? {} : { stdoutBytes: row.stdoutBytes }),
    ...(row.stderrBytes === undefined ? {} : { stderrBytes: row.stderrBytes }),
  };
}

/** journal 的 `WorkflowErrorJson` → 端口的 code + message（其余字段不出端口；message 切尾）。 */
function toRunError(error: { code: string; message: string }): DynamicWorkflowRunError {
  const message =
    error.message.length > ERROR_MESSAGE_MAX_CHARS
      ? `${error.message.slice(0, ERROR_MESSAGE_MAX_CHARS - 1)}…`
      : error.message;
  return { code: error.code, message };
}

/** 一个节点的正文，按 `query.maxBytes` 保形有界化。 */
export async function readWorkspaceNodeResultFrom(
  deps: WorkflowWorkspaceReadDeps,
  runId: string,
  siteId: string,
  ordinal: number,
  query: DynamicWorkflowRunWorkspaceNodeResultQuery,
): Promise<DynamicWorkflowRunWorkspaceNodeResult | undefined> {
  if (!authorizeRun(deps, runId)) return undefined;
  const node = deps.journal.getNode(runId, siteId, ordinal);
  if (node === undefined) return undefined;
  if (node.kind !== "world-read" && node.kind !== "world-run") return undefined;
  return toNodeResult(node, query.maxBytes);
}

function toNodeResult(node: NodeRecord, maxBytes: number): DynamicWorkflowRunWorkspaceNodeResult {
  if (node.status === "failed") {
    return {
      status: "failed",
      ...(node.error === undefined ? {} : { error: toRunError(node.error) }),
      truncated: false,
      totalBytes: 0,
    };
  }
  if (node.status !== "completed" || !("result" in node)) {
    return { status: node.status, truncated: false, totalBytes: 0 };
  }
  const bounded = boundWorkspaceResult(node.result, maxBytes);
  return {
    status: "completed",
    result: bounded.result,
    truncated: bounded.truncated,
    totalBytes: bounded.totalBytes,
  };
}

// ── 保形有界化 ──────────────────────────────────────────────────────────────
// 引擎侧 `WORLD_READ_CAPS` 的政策是「溢出即拒绝、绝不截断后加个标志位」——那是脚本的取数面，
// 半份 grep 结果会让脚本做错决定。这里是审计面：一张卡片要的是「跑了什么、前几百行是什么」，
// 截断并**说明**截断（`truncated` + `totalBytes`）比一个「太大读不了」有用得多。

function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** 把字符串切到 ≤ maxBytes 个 UTF-8 字节，不切在代理对中间。 */
function truncateUtf8(text: string, maxBytes: number): string {
  if (utf8ByteLength(text) <= maxBytes) return text;
  const bytes = Buffer.from(text, "utf8").subarray(0, Math.max(0, maxBytes));
  // 去掉尾部不完整的多字节序列：decode 会把它换成 U+FFFD，我们宁可少一个字符。
  let end = bytes.length;
  while (end > 0 && (bytes[end - 1]! & 0b1100_0000) === 0b1000_0000) end -= 1;
  if (end > 0 && (bytes[end - 1]! & 0b1100_0000) === 0b1100_0000) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

/**
 * 按正文形状有界化：
 * - 字符串（read / diff / status）：切尾；
 * - 数组（glob / grep / changedFiles / log）：逐项累加，放不下的去尾；
 * - `world.run` 的 `{exitCode, stdout, stderr}`：exitCode 恒保留，两路输出各分一半预算；
 * - 其它：序列化后不超限原样，超限退化成切尾的 JSON 文本（形状已不可保）。
 */
export function boundWorkspaceResult(
  result: unknown,
  maxBytes: number,
): { result: unknown; truncated: boolean; totalBytes: number } {
  const serialized = JSON.stringify(result) ?? "null";
  const totalBytes = utf8ByteLength(serialized);
  if (totalBytes <= maxBytes) return { result, truncated: false, totalBytes };

  if (typeof result === "string") {
    return { result: truncateUtf8(result, maxBytes), truncated: true, totalBytes };
  }
  if (Array.isArray(result)) {
    const kept: unknown[] = [];
    let used = 2; // 方括号
    for (const item of result) {
      const itemBytes = utf8ByteLength(JSON.stringify(item) ?? "null") + 1;
      if (used + itemBytes > maxBytes) break;
      kept.push(item);
      used += itemBytes;
    }
    return { result: kept, truncated: true, totalBytes };
  }
  if (isRunResult(result)) {
    const overhead = utf8ByteLength(JSON.stringify({ ...result, stdout: "", stderr: "" }));
    const budget = Math.max(0, maxBytes - overhead);
    const stderrWant = utf8ByteLength(result.stderr);
    const stdoutWant = utf8ByteLength(result.stdout);
    // 各分一半；一路用不完的余额让给另一路。
    const stderrBudget = Math.min(stderrWant, Math.max(budget >> 1, budget - stdoutWant));
    const stdoutBudget = Math.max(0, budget - stderrBudget);
    return {
      result: {
        ...result,
        stdout: truncateUtf8(result.stdout, stdoutBudget),
        stderr: truncateUtf8(result.stderr, stderrBudget),
      },
      truncated: true,
      totalBytes,
    };
  }
  return { result: truncateUtf8(serialized, maxBytes), truncated: true, totalBytes };
}

function isRunResult(
  value: unknown,
): value is { exitCode: number; stdout: string; stderr: string } & Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>;
  return (
    typeof fields.exitCode === "number" &&
    typeof fields.stdout === "string" &&
    typeof fields.stderr === "string"
  );
}
