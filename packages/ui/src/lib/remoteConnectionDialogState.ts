import type { RemoteWizardStep } from "@/RemoteConnectionWizardChrome.js";

export interface RemoteConnectionDialogSnapshot {
  currentStep: RemoteWizardStep;
  loading: boolean;
  connectedSessionId: string | null;
}

type RemoteConnectionCompletionStatus = "success" | "error";

interface RemoteConnectionCompletionDialogState {
  open: boolean;
  step: RemoteWizardStep;
}

interface RemoteConnectionDirectoryFailureState {
  connectedSessionId: string | null;
  step: RemoteWizardStep;
}

export function isRemoteConnectionFlowActive(
  snapshot: RemoteConnectionDialogSnapshot,
): boolean {
  return snapshot.loading || Boolean(snapshot.connectedSessionId);
}

export function getRemoteConnectionCompletionDialogState(
  status: RemoteConnectionCompletionStatus,
  options?: { directToDirectory?: boolean },
): RemoteConnectionCompletionDialogState {
  return {
    // 远程连接弹窗收起后，连接完成只更新内部步骤但没有重新展示弹窗，
    // 用户会停留在其它页面且看不到选目录或失败原因。连接完成后统一拉起弹窗到结果步骤。
    open: true,
    // 连接成功后先停留在连接阶段，让用户明确点击“前往选择目录”进入下一步；
    // 唯一例外是第 1 步在线设备的「选择其他目录」直达流（原型 rail-foot：已有设备可从第 1 步直达第 5 步），
    // 建链秒成后直接进入选目录，不再停留等待一次多余的点击。
    step:
      status === "success" && options?.directToDirectory
        ? "directory"
        : "connecting",
  };
}

export function getRemoteConnectionDirectoryFailureState(params: {
  connectedSessionId: string;
  sessionStillRegistered: boolean;
}): RemoteConnectionDirectoryFailureState {
  if (params.sessionStillRegistered) {
    return {
      connectedSessionId: params.connectedSessionId,
      step: "directory",
    };
  }

  // workspace 初始化失败会回收未确认 logical session。
  // 目录步骤继续持有旧 sessionId 时只能拿到空 services，并永久显示“加载中”。
  return {
    connectedSessionId: null,
    step: "settings",
  };
}
