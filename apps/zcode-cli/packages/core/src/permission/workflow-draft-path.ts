// ============================================================
// Workflow draft path - 「这个写入目标落在草稿目录里吗」的纯判定
// ============================================================
//
// 单独成模块有两个理由：PermissionService 只需要一个布尔值，不需要知道路径怎么比；
// 而这条判定是免确认的**唯一**闸门，必须能脱离 service 被逐例测到（含 Windows 语义）。
// 全程不碰文件系统：不 realpath、不 stat。权限判定必须是纯函数——同一份输入在任何机器上
// 给出同一个答案，且不会因为一次磁盘读失败而把「不放行」错判成「放行」。

import nodePath from "node:path";

import { WORKFLOW_DRAFTS_DIR } from "@zcode/contracts";

/**
 * 判定所需的 `node:path` 子集。做成参数是为了在测试里注入 `path.win32` / `path.posix`：
 * 盘符、反斜杠和大小写这些 Windows 语义，只有用 win32 实现跑一遍才算验过。
 */
export interface WorkflowDraftPathModule {
  isAbsolute: (path: string) => boolean;
  relative: (from: string, to: string) => string;
  resolve: (...paths: string[]) => string;
}

export interface WorkflowDraftPathInput {
  /** 工具输入里的写入目标，相对路径按 workingDirectory 解析，绝对路径原样保留。 */
  filePath: string;
  /** 会话工作目录；缺席（空串）即不成立，见下。 */
  workingDirectory: string;
  /** 平台 path 实现，默认取当前平台的 `node:path`。 */
  pathModule?: WorkflowDraftPathModule;
}

/**
 * 命中草稿免确认的内置写文件工具。这两个共用 `edit` 权限名，且都以单一 `file_path` 指向
 * 目标——判定"目标在不在草稿目录里"才有意义。同为 `edit` 的 ApplyPatch 不在其列：它的输入是
 * `patch_text` 补丁正文，一次可以改多个文件，没有单一路径可判。
 */
const WORKFLOW_DRAFT_PREAPPROVED_TOOL_NAMES = new Set(["Edit", "Write"]);

export interface WorkflowDraftWriteInput {
  toolName: string;
  /** 工具输入（尚未按具体工具的 schema 解析），只从中取 `file_path`。 */
  input: unknown;
  /** 会话工作目录；调用方拿不到时可以缺席，缺席即不免确认。 */
  workingDirectory?: string;
  pathModule?: WorkflowDraftPathModule;
}

/**
 * 这次工具调用是不是「往草稿目录里写」，也就是能不能免掉确认窗。
 *
 * 为什么安全：那个目录是机器自有的——里面的文件由工具自己写下，目录自带 `*` 的 .gitignore
 * 而不进版本库，用户不会往里放需要保护的东西，改动一份草稿不影响项目里任何东西。而
 * 「让脚本跑起来」另有一道闸：CreateWorkflow 声明 alwaysAsk，确认窗看的是提交上来的脚本，
 * 无论该文件曾被改成什么样。所以放行这里的写入并不等于放行任何执行。
 *
 * 没有 workingDirectory（调用方没传）就一律不成立：免确认的前提是能算出目标落在哪，
 * 算不出时该弹的窗照弹。
 */
export function isPreapprovedWorkflowDraftWrite(input: WorkflowDraftWriteInput): boolean {
  if (!WORKFLOW_DRAFT_PREAPPROVED_TOOL_NAMES.has(input.toolName)) return false;
  if (typeof input.workingDirectory !== "string") return false;
  if (!input.input || typeof input.input !== "object") return false;
  const filePath = (input.input as Record<string, unknown>).file_path;
  if (typeof filePath !== "string") return false;
  return isWorkflowDraftPath({
    filePath,
    pathModule: input.pathModule,
    workingDirectory: input.workingDirectory,
  });
}

/** `filePath` 是否落在 `<workingDirectory>/.zcode/workflow-drafts/` 之内。 */
export function isWorkflowDraftPath(input: WorkflowDraftPathInput): boolean {
  const path = input.pathModule ?? nodePath;
  // 没有工作目录就没有"哪个项目的草稿目录"可言，宁可不放行：免确认的前提是目标可被定位。
  if (input.workingDirectory.length === 0 || input.filePath.length === 0) return false;

  const draftsDir = path.resolve(input.workingDirectory, WORKFLOW_DRAFTS_DIR);
  const resolved = path.resolve(input.workingDirectory, input.filePath);
  const relativePath = path.relative(draftsDir, resolved);

  // 三个条件缺一不可：非空排除「目标就是目录本身」，非绝对排除跨盘符（Windows 上
  // `relative("C:\\a", "D:\\b")` 返回的是绝对路径而不是 `..`），不以 `..` 开头排除穿越。
  // 只看路径字符串，不看文件系统：`.zcode/workflow-drafts-other/x.ts` 因此不会因为前缀
  // 相同被误判为目录内——`relative` 给出的是 `../workflow-drafts-other/x.ts`。
  return (
    relativePath.length > 0 && !path.isAbsolute(relativePath) && !relativePath.startsWith("..")
  );
}
