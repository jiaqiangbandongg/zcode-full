import { isAuxiliarySessionKind } from "@zcode/shared";
import { resolveWorkspaceKey } from "@zcode/shared";
import type { SubagentIndexRepair } from "#src/task-facts/contract.js";

const IDENTITY_QUERY_BATCH_SIZE = 64;

/** 旧版本曾把冷恢复 child 写入主列表；只清理权威身份确认的派生索引，不删除 Agent 转录。 */
export async function repairSubagentTaskIndex(params: SubagentIndexRepair): Promise<void> {
  const { target, taskIndexRepo, agentService, isCurrent } = params;
  // 旧索引可能保留旧 provider 标签；是否为 child 只按 CLI 返回的权威身份裁决。
  const rows = await taskIndexRepo.listTaskMetas(target);
  const ids = rows
    .filter((row) => !params.visibleSessionIds.has(row.taskId))
    .map((row) => row.taskId);
  for (let offset = 0; offset < ids.length; offset += IDENTITY_QUERY_BATCH_SIZE) {
    if (!isCurrent()) return;
    const batch = ids.slice(offset, offset + IDENTITY_QUERY_BATCH_SIZE);
    const sessions = await agentService.listSessions({
      ...target,
      sessionIds: batch,
      runtimePolicy: "existing-only",
    });
    // 旧 Agent 不支持参数时直接失败；缺失记录、跨身份结果和已失效订阅均不能推断为可删除。
    for (const session of sessions) {
      if (!isCurrent()) return;
      if (
        !isAuxiliarySessionKind(session.sessionKind) ||
        !batch.includes(session.sessionId) ||
        resolveWorkspaceKey(session.workspace) !== resolveWorkspaceKey(target)
      )
        continue;
      await taskIndexRepo.removeSubagentIndexRow({
        ...target,
        taskId: session.sessionId,
      });
      if (isCurrent()) params.onRemoved();
    }
  }
}
