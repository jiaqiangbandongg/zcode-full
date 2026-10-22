import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import type {
  GroupTaskRef,
  MoveGroupNode,
  ProjectTree,
  TaskGroup,
  TaskGroupStructure,
} from "@/project-sidebar/contract.js";
import { groupTaskRef } from "@/project-sidebar/grouped-view.js";
import { logger } from "@/logger.js";
const EMPTY: TaskGroupStructure = { groups: [], members: [], order: [] };
/** 控制端唯一订阅；三个筛选视图和所有任务菜单共享同一份已接受结构。 */
export function useTaskGroups(tree: ProjectTree) {
  const services = useBaseWorkspaceServices();
  const service = services.taskGroupService;
  const [structure, setStructure] = useState(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const serial = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++serial.current;
    if (!service) {
      setStructure(EMPTY);
      return;
    }
    try {
      const next = await service.read();
      if (request === serial.current) {
        setStructure(next);
        setError(null);
      }
    } catch (cause) {
      if (request === serial.current) {
        setError(String(cause));
        logger.error("[task-groups] 读取分组失败", cause);
      }
    }
  }, [service]);
  useEffect(() => {
    void refresh();
    const subscription = services.broadcastService.onMessage((event) => {
      if (event.channel === "state:task-groups") void refresh();
    });
    return () => {
      serial.current++;
      subscription.dispose();
    };
  }, [services.broadcastService, refresh]);
  // 活动时间/stream 不触发登记；仅首次身份、系统标记和明确删除有组织语义。
  const signature = useMemo(() => {
    // 原来每次活动渲染都排序并在比较器中反复序列化；只在事实输入变化时计算一次键。
    const entries = [
      ...tree.tasks.map((task) => [groupTaskRef(task), task.cronAutomationId, task.offPeakTaskId]),
      ...(tree.deletedTasks ?? []).map((task) => [task, "deleted"]),
    ].map((entry) => JSON.stringify(entry));
    entries.sort((a, b) => a.localeCompare(b));
    return `[${entries.join(",")}]`;
  }, [tree.tasks, tree.deletedTasks]);
  useEffect(() => {
    if (!service) return;
    const entries = JSON.parse(signature) as Array<[GroupTaskRef]>;
    const byHost = new Map<string, GroupTaskRef[]>();
    for (const [task] of entries) {
      const refs = byHost.get(task.hostId) ?? [];
      refs.push(task);
      byHost.set(task.hostId, refs);
    }
    let active = true;
    void Promise.allSettled(
      [...byHost.values()].map(async (tasks) => {
        // 同一 Host 顺序分批，避免大库超过命令上限；一个设备失败不覆盖其他设备的组织态。
        for (let start = 0; start < tasks.length; start += 5000)
          await service.admit({ tasks: tasks.slice(start, start + 5000) });
      }),
    ).then((results) => {
      for (const result of results)
        if (result.status === "rejected")
          logger.warn("[task-groups] 任务登记未完成，保留原结构", result.reason);
      if (active) void refresh();
    });
    return () => {
      active = false;
    };
  }, [service, signature, refresh]);
  const required = useCallback(() => {
    if (!service) throw new Error("task-group.service-unavailable");
    return service;
  }, [service]);
  const save = useCallback(
    async (input: { id?: string; title?: string; color?: TaskGroup["color"] }) => {
      const result = await required().save(input);
      await refresh();
      return result;
    },
    [required, refresh],
  );
  const move = useCallback(
    async (input: MoveGroupNode) => {
      await required().move(input);
      await refresh();
    },
    [required, refresh],
  );
  const ungroup = useCallback(
    async (id: string) => {
      await required().ungroup(id);
      await refresh();
    },
    [required, refresh],
  );
  const parents = useMemo(
    () =>
      new Map(
        structure.members.map((member) => [
          JSON.stringify([member.workspaceKey, member.taskId]),
          member.groupId,
        ]),
      ),
    [structure],
  );
  return useMemo(
    () => ({
      structure,
      parents,
      error,
      refresh,
      save,
      move,
      ungroup,
      available: Boolean(service),
    }),
    [structure, parents, error, refresh, save, move, ungroup, service],
  );
}
