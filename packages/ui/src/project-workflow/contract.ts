import type {
  ZCodeSavedWorkflowEntry,
  ZCodeSavedWorkflowMeta,
  ZCodeSavedWorkflowScope,
  ZCodeWorkflowsForRunCandidate,
  ZCodeWorkflowsSaveResult,
} from "@zcode/shared";
import type { WorkflowRunSavedState } from "@/store/workflowRunSavedStore.js";
import type {
  SavedWorkflowLaunchError,
  SavedWorkflowLaunchTarget,
} from "@/settings/saved-workflows/useSavedWorkflowLauncher.js";

export interface WorkflowRunSaveTarget {
  projectId?: string | null;
  hostId?: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export interface WorkflowRunSaveHost extends WorkflowRunSaveTarget {
  sessionId?: string;
  runId: string;
  /** 转写自对话的候选（`buildWorkflowSaveCandidatesByRunId`）。 */
  candidates?: readonly ZCodeWorkflowsForRunCandidate[];
  /** 启动成功后切到新会话；缺席即宿主不会导航（手机远控首页、静态渲染）。 */
  onNavigateToRun?: (target: SavedWorkflowLaunchTarget, sessionId: string) => void;
}

export interface WorkflowRunSaveSubmit {
  name: string;
  scope: ZCodeSavedWorkflowScope;
  meta: ZCodeSavedWorkflowMeta;
  overwrite?: boolean;
}

export interface WorkflowRunSaveController {
  /** 这次 run 的已保存工作流（推导）。`undefined` = 还没查回来。 */
  saved: WorkflowRunSavedState | undefined;
  /** 已保存的那一份；缺席即没有。 */
  entry: ZCodeSavedWorkflowEntry | undefined;
  /** 这次 run 跑过的实参，给「再次运行」的实参窗做预填。 */
  runArgs: Record<string, unknown> | undefined;
  /** 老 agent 没有 `workflows/save`：弹层只留 ZCode 那条路。 */
  directSaveUnsupported: boolean;
  /** 远程项目不给全局档：`~` 在 agent 机器上，中枢从不读它。 */
  scopeLocked: boolean;
  saving: boolean;
  save: (input: WorkflowRunSaveSubmit) => Promise<ZCodeWorkflowsSaveResult>;
  /** 名字是否已被占用（弹层输入时的前置探测）；查不动时按「不占用」处理，最终裁决在 agent。 */
  checkNameTaken: (name: string, scope: ZCodeSavedWorkflowScope) => Promise<boolean>;
  launching: boolean;
  launchError: SavedWorkflowLaunchError | null;
  clearLaunchError: () => void;
  /** 「再次运行」：按 entry 启动；实参缺省用这次 run 跑过的那份。 */
  launch: (
    entry: ZCodeSavedWorkflowEntry,
    args: Record<string, unknown>,
    target?: WorkflowRunSaveTarget,
  ) => Promise<{ ok: true } | { ok: false; error: SavedWorkflowLaunchError }>;
}
