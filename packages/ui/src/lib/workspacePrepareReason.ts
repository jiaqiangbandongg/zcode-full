import type { ZCodeProvider } from "@zcode/shared";

type DraftWorkspacePrepareReason = "mount" | "select-provider";
type WorkspacePrepareReason =
  | DraftWorkspacePrepareReason
  | "retry"
  | "first-send";

interface ResolveDraftWorkspacePrepareReasonOptions {
  previousDraftProvider: ZCodeProvider | null;
  previousTaskProvider: ZCodeProvider | null;
  selectedProvider: ZCodeProvider;
  returningFromTask: boolean;
}

export function resolveDraftWorkspacePrepareReason({
  previousDraftProvider,
  previousTaskProvider,
  selectedProvider,
  returningFromTask,
}: ResolveDraftWorkspacePrepareReasonOptions): DraftWorkspacePrepareReason {
  // Bugfix: task -> draft 场景下，若用户在 task 内先切了 provider，
  // 之前会被统一判成 mount，导致草稿继续沿用上个 provider 的 configOptions，
  // 模型下拉短暂甚至持续显示旧任务模型。这里改成“provider 变化”优先按 select-provider，
  // 只有 provider 不变时才走 mount，兼顾正确性与避免无效 loading。
  if (previousDraftProvider === null) {
    return "mount";
  }

  if (returningFromTask) {
    // Bugfix: 用户可能在“仍停留旧 task 详情”时就通过侧栏把下个草稿 provider 改掉。
    // 这会提前覆盖 workspace.selectedProvider，导致仅靠 previousDraftProvider 比较时
    // 误判成“provider 未变化”。这里优先用 task 切走前冻结的 provider 作为参照，
    // 确保 task -> draft 能正确识别跨 provider 切换并走 select-provider 清理旧配置。
    const taskProviderBeforeDraft = previousTaskProvider ?? previousDraftProvider;
    return taskProviderBeforeDraft === selectedProvider ? "mount" : "select-provider";
  }

  return previousDraftProvider === selectedProvider ? "mount" : "select-provider";
}

interface ShouldShowDraftWorkspacePrepareLoadingOptions {
  taskId: string | null;
  reason: WorkspacePrepareReason;
  hasHydratedConfigOptions: boolean;
}

export function shouldShowDraftWorkspacePrepareLoading({
  taskId,
  reason,
  hasHydratedConfigOptions,
}: ShouldShowDraftWorkspacePrepareLoadingOptions): boolean {
  if (taskId) {
    return false;
  }

  if (reason === "select-provider") {
    return true;
  }

  // Bugfix: 首屏冷启动时，selectedProvider 会先按最近一次选择恢复，
  // 但模型配置仍要等异步 prepareWorkspace 回来。
  // 之前 mount 路径没有进入 loading，导致工具栏会先显示默认 Agent，
  // 却没有“加载中”提示。这里仅在“还没有任何 configOptions 快照”时补上 loading，
  // 既修复首屏无反馈的问题，也避免 task -> draft 时重复闪烁。
  return reason === "mount" && !hasHydratedConfigOptions;
}
