// 完成卡与 run 侧板共用的「保存 / 再次运行」控制器（docs/dynamic-workflow/transcript-and-notifications.md
// 「Saving the run, and running it again」）。
//
// 一个 hook 而不是两份接线：同一个 run 在卡上与侧板上必须说同一句话、走同一条命令。它负责
//   1. 这次 run 对应哪个已保存工作流（推导，缓存在 workflowRunSavedStore）；
//   2. 「直接保存」= `workflows/save`（按 runId 取脚本，无模型回合）；
//   3. 「再次运行」= 中枢那台启动器（`useSavedWorkflowLauncher`），实参取这次 run 跑过的那份。
// 「让 ZCode 帮我提炼保存」不在这里：它只是把一条用户消息交回宿主发出去（卡在会话里、侧板在父
// 会话里），宿主各有各的发送路径。
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  resolveWorkspaceKey,
  type ZCodeSavedWorkflowEntry,
  type ZCodeSavedWorkflowMeta,
  type ZCodeSavedWorkflowScope,
  type ZCodeWorkflowsForRunCandidate,
  type ZCodeWorkflowsSaveResult,
} from "@zcode/shared";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import {
  selectWorkflowRunSavedState,
  useWorkflowRunSavedStore,
  workflowRunSavedKey,
  type WorkflowRunSavedState,
} from "@/store/workflowRunSavedStore.js";
import {
  useSavedWorkflowLauncher,
  type SavedWorkflowLaunchError,
  type SavedWorkflowLaunchTarget,
} from "@/settings/saved-workflows/useSavedWorkflowLauncher.js";

export interface WorkflowRunSaveTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export interface WorkflowRunSaveHost extends WorkflowRunSaveTarget {
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

export function useWorkflowRunSave(host: WorkflowRunSaveHost): WorkflowRunSaveController {
  const { candidates, runId, onNavigateToRun } = host;
  const resolution = useWorkspaceServicesResolution(
    host.workspacePath,
    host.remoteSessionId ?? null,
    host.workspaceIdentity,
  );
  const { rpcReady, services } = resolution;
  const agentService = services.zcodeAgentService;
  const isRemote = resolution.isRemoteTarget;

  const target = useMemo<WorkflowRunSaveTarget>(
    () => ({
      workspacePath: host.workspacePath,
      ...(host.workspaceIdentity ? { workspaceIdentity: host.workspaceIdentity } : {}),
      ...(resolution.remoteSessionId ? { remoteSessionId: resolution.remoteSessionId } : {}),
    }),
    [host.workspacePath, host.workspaceIdentity, resolution.remoteSessionId],
  );
  const workspaceKey = useMemo(
    () =>
      resolveWorkspaceKey({
        workspacePath: host.workspacePath,
        ...(host.workspaceIdentity ? { workspaceIdentity: host.workspaceIdentity } : {}),
      }),
    [host.workspacePath, host.workspaceIdentity],
  );
  const key = useMemo(
    () => workflowRunSavedKey(workspaceKey, runId, candidates),
    [candidates, runId, workspaceKey],
  );

  const generation = useWorkflowRunSavedStore((state) => state.generation);
  const load = useWorkflowRunSavedStore((state) => state.load);
  const applySaved = useWorkflowRunSavedStore((state) => state.applySaved);
  const saved = useWorkflowRunSavedStore((state) => selectWorkflowRunSavedState(state, key));

  useEffect(() => {
    if (!rpcReady) return;
    // `generation` 在依赖里：一次作废让所有在场的卡片重查（保存、删除、中枢刷新都会作废）。
    void generation;
    void load(key, () =>
      agentService.findSavedWorkflowForRun({
        ...target,
        runId,
        ...(candidates === undefined || candidates.length === 0 ? {} : { candidates }),
      }),
    );
  }, [agentService, candidates, generation, key, load, rpcReady, runId, target]);

  const [saving, setSaving] = useState(false);
  const save = useCallback(
    async (input: WorkflowRunSaveSubmit) => {
      setSaving(true);
      try {
        const result = await agentService.saveSavedWorkflowFromRun({
          ...target,
          runId,
          name: input.name,
          meta: input.meta,
          scope: input.scope,
          ...(input.overwrite === undefined ? {} : { overwrite: input.overwrite }),
        });
        if (result.ok) {
          // 刚写成的那一份立刻摆上去（卡片翻成「已保存 / 再次运行」），同时作废别的卡的答案。
          applySaved(key, {
            name: result.name,
            description: input.meta.description,
            ...(input.meta.whenToUse === undefined ? {} : { whenToUse: input.meta.whenToUse }),
            ...(input.meta.args === undefined ? {} : { args: input.meta.args }),
            scope: result.scope,
            path: result.path,
          });
        }
        return result;
      } finally {
        setSaving(false);
      }
    },
    [agentService, applySaved, key, runId, target],
  );

  const checkNameTaken = useCallback(
    async (name: string, scope: ZCodeSavedWorkflowScope) => {
      try {
        const result = await agentService.getSavedWorkflow({ ...target, name, scope });
        return result.ok;
      } catch {
        // 探测失败不该挡住保存：agent 仍会用 `target_exists` 给出最终答案。
        return false;
      }
    },
    [agentService, target],
  );

  const launcher = useSavedWorkflowLauncher({
    agentService,
    ...(onNavigateToRun === undefined ? {} : { onNavigate: onNavigateToRun }),
  });
  const launch = useCallback(
    async (
      entry: ZCodeSavedWorkflowEntry,
      args: Record<string, unknown>,
      launchTarget?: WorkflowRunSaveTarget,
    ) => {
      const destination = launchTarget ?? target;
      const result = await launcher.launch(
        {
          workspacePath: destination.workspacePath,
          ...(destination.workspaceIdentity
            ? { workspaceIdentity: destination.workspaceIdentity }
            : {}),
          ...(destination.remoteSessionId ? { remoteSessionId: destination.remoteSessionId } : {}),
        },
        { name: entry.name, scope: entry.scope, args },
      );
      return result.ok ? { ok: true as const } : { ok: false as const, error: result.error };
    },
    [launcher, target],
  );

  return {
    saved,
    entry: saved?.entry,
    runArgs: saved?.runArgs,
    directSaveUnsupported: saved?.status === "unsupported",
    scopeLocked: isRemote,
    saving,
    save,
    checkNameTaken,
    launching: launcher.pending,
    launchError: launcher.error,
    clearLaunchError: launcher.clearError,
    launch,
  };
}
