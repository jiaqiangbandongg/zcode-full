import type { ZCodeTaskMeta } from "@zcode/shared";
import type { TaskIndexRepo } from "#src/session/taskIndexRepo.js";

/** 测试分别设置 CLI 事实和 Host 组织态，不为夹具保留生产环境的整行写入入口。 */
export async function seedTaskIndex(
  repo: TaskIndexRepo,
  input: {
    meta: ZCodeTaskMeta;
    pinned?: boolean;
    archived?: boolean;
    deleted?: boolean;
    titleOverridden?: boolean;
    searchableText?: string;
  },
): Promise<ZCodeTaskMeta> {
  const { meta } = input;
  await repo.applyCliFacts({
    meta,
    titleSource: (input.titleOverridden ?? meta.titleOverridden) ? "custom" : "generated",
    lastOutcome: meta.status === "completed" || meta.status === "error" ? meta.status : undefined,
  });
  const {
    mode,
    model,
    thoughtLevel,
    lastError,
    target,
    migrationSource,
    cronAutomationId,
    offPeakTaskId,
  } = meta;
  await repo.updateTaskPresentation({
    ...meta,
    presentation: Object.fromEntries(
      Object.entries({
        mode,
        model,
        thoughtLevel,
        lastError,
        target,
        migrationSource,
        cronAutomationId,
        offPeakTaskId,
      }).filter(([, value]) => value !== undefined),
    ),
    searchableText: input.searchableText,
  });
  if (input.pinned !== undefined || input.archived !== undefined)
    await repo.updateTaskState({
      ...meta,
      patch: {
        ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
        ...(input.archived !== undefined ? { archived: input.archived } : {}),
      },
    });
  if (input.deleted) await repo.applyCliDeletion(meta);
  return (await repo.getTaskMeta(meta))!;
}
