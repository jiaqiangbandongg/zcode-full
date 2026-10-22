import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  CRON_DEFAULT_GROUP_ID,
  OFF_PEAK_DEFAULT_GROUP_ID,
  resolveWorkspaceKey,
} from "@zcode/shared";
import type {
  GroupNode,
  GroupTaskFact,
  GroupTaskRef,
  ITaskGroupService,
  MoveGroupNode,
  TaskGroup,
  TaskGroupStructure,
} from "#src/task-groups/contract.js";

type OrderedNode = { type: "task" | "group"; key: string };
type Admission = { system_kind: string | null; user_organized: number; creation_id: string | null };
export function groupTaskKey(
  task: Pick<GroupTaskRef, "workspacePath" | "workspaceIdentity" | "taskId">,
) {
  return JSON.stringify([resolveWorkspaceKey(task), task.taskId]);
}
function nodeKey(node: GroupNode): OrderedNode {
  return node.type === "group"
    ? { type: "group", key: node.groupId }
    : { type: "task", key: groupTaskKey(node.task) };
}
function equalNode(a: OrderedNode, b: OrderedNode) {
  return a.type === b.type && a.key === b.key;
}

/** 复用旧表的控制端组织仓库；同步 SQLite 事务内没有 await，不跨进程改写任务事实。 */
export class TaskGroupRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {}
  private transaction<T>(run: () => T): T {
    const own = !this.db.isTransaction;
    if (own) this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      if (own) this.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (own && this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }
  read(): TaskGroupStructure {
    const own = !this.db.isTransaction;
    if (own) this.db.exec("BEGIN");
    try {
      const result = {
        groups: this.db
          .prepare(
            "SELECT group_id AS id,title,coalesce(color,'gray') AS color,created_at AS createdAt,updated_at AS updatedAt FROM task_groups ORDER BY created_at,group_id",
          )
          .all() as unknown as TaskGroup[],
        members: this.db
          .prepare(
            "SELECT group_id AS groupId,workspace_key AS workspaceKey,task_id AS taskId,coalesce(sort_order,-added_at) AS sortOrder FROM task_group_members ORDER BY sortOrder,workspace_key,task_id",
          )
          .all() as unknown as TaskGroupStructure["members"],
        order: this.db
          .prepare(
            "SELECT node_type AS type,node_key AS key,sort_order AS sortOrder FROM task_group_view_node_orders ORDER BY sort_order,node_type,node_key",
          )
          .all() as unknown as TaskGroupStructure["order"],
      };
      if (own) this.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (own && this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private hasGroup(id: string) {
    return Boolean(this.db.prepare("SELECT 1 FROM task_groups WHERE group_id=?").get(id));
  }
  private parent(task: GroupTaskRef): string | null {
    return (
      (this.db
        .prepare("SELECT group_id FROM task_group_members WHERE workspace_key=? AND task_id=?")
        .get(resolveWorkspaceKey(task), task.taskId)?.group_id as string | undefined) ?? null
    );
  }
  private children(groupId: string | null): OrderedNode[] {
    const structure = this.read();
    if (groupId)
      return structure.members
        .filter((member) => member.groupId === groupId)
        .map((member) => ({
          type: "task",
          key: JSON.stringify([member.workspaceKey, member.taskId]),
        }));
    const members = new Set(
      structure.members.map((member) => JSON.stringify([member.workspaceKey, member.taskId])),
    );
    const groups = new Set(structure.groups.map((group) => group.id));
    const nodes = structure.order.filter((node) =>
      node.type === "group" ? groups.has(node.key) : !members.has(node.key),
    );
    const ordered = new Set(nodes.filter((node) => node.type === "group").map((node) => node.key));
    return [
      ...nodes,
      ...structure.groups
        .filter((group) => !ordered.has(group.id))
        .map((group) => ({ type: "group" as const, key: group.id })),
    ];
  }
  private writeOrder(nodes: OrderedNode[], groupId: string | null) {
    const now = this.now();
    nodes.forEach((node, position) => {
      if (groupId) {
        const [workspaceKey, taskId] = JSON.parse(node.key) as [string, string];
        this.db
          .prepare(
            "UPDATE task_group_members SET sort_order=?,updated_at=? WHERE group_id=? AND workspace_key=? AND task_id=?",
          )
          .run(position, now, groupId, workspaceKey, taskId);
      } else {
        this.db
          .prepare(`INSERT INTO task_group_view_node_orders(node_type,node_key,sort_order,created_at,updated_at)
          VALUES(?,?,?,?,?) ON CONFLICT(node_type,node_key) DO UPDATE SET sort_order=excluded.sort_order,updated_at=excluded.updated_at`)
          .run(node.type, node.key, position, now, now);
      }
    });
  }
  save(input: { id?: string; title?: string; color?: TaskGroup["color"] }): TaskGroup {
    return this.transaction(() => {
      const previous = input.id
        ? this.read().groups.find((group) => group.id === input.id)
        : undefined;
      if (input.id && !previous) throw new Error("task-group.not-found");
      const group: TaskGroup = {
        id: previous?.id ?? randomUUID(),
        title: input.title?.trim() ?? previous?.title ?? "New group",
        color: input.color ?? previous?.color ?? "gray",
        createdAt: previous?.createdAt ?? this.now(),
        updatedAt: this.now(),
      };
      if (!group.title) throw new Error("task-group.title-required");
      this.db
        .prepare(`INSERT INTO task_groups(group_id,title,color,created_at,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(group_id) DO UPDATE SET title=excluded.title,color=excluded.color,updated_at=excluded.updated_at`)
        .run(group.id, group.title, group.color, group.createdAt, group.updatedAt);
      if (!previous)
        this.writeOrder(
          [
            { type: "group", key: group.id },
            ...this.children(null).filter((node) => node.key !== group.id),
          ],
          null,
        );
      return group;
    });
  }
  ungroup(id: string): void {
    this.transaction(() => {
      if (!this.hasGroup(id)) return;
      const members = this.children(id);
      const root = this.children(null).flatMap((node) =>
        node.type === "group" && node.key === id ? members : [node],
      );
      for (const member of members) {
        const [workspaceKey, taskId] = JSON.parse(member.key) as [string, string];
        this.markOrganized(workspaceKey, taskId);
      }
      this.db.prepare("DELETE FROM task_group_members WHERE group_id=?").run(id);
      this.db.prepare("DELETE FROM task_groups WHERE group_id=?").run(id);
      this.db
        .prepare("DELETE FROM task_group_view_node_orders WHERE node_type='group' AND node_key=?")
        .run(id);
      this.writeOrder(root, null);
    });
  }
  private markOrganized(workspaceKey: string, taskId: string) {
    this.db
      .prepare(`INSERT INTO task_group_admissions(workspace_key,task_id,user_organized) VALUES(?,?,1)
      ON CONFLICT(workspace_key,task_id) DO UPDATE SET user_organized=1`)
      .run(workspaceKey, taskId);
  }
  move(input: MoveGroupNode): void {
    this.transaction(() => this.moveInside(input, true));
  }
  private moveInside(input: MoveGroupNode, manual: boolean) {
    const node = nodeKey(input.node);
    const parent = input.node.type === "task" ? this.parent(input.node.task) : null;
    if (parent !== input.sourceGroupId) throw new Error("task-group.stale-source");
    if (input.node.type === "group" && (input.groupId || !this.hasGroup(input.node.groupId)))
      throw new Error("task-group.invalid-group");
    if (input.groupId && !this.hasGroup(input.groupId)) throw new Error("task-group.not-found");
    const destination = this.children(input.groupId).filter(
      (candidate) => !equalNode(candidate, node),
    );
    const anchor = input.anchor && nodeKey(input.anchor.node);
    const index = anchor ? destination.findIndex((candidate) => equalNode(candidate, anchor)) : 0;
    if (index < 0) throw new Error("task-group.stale-anchor");
    destination.splice(index + (input.anchor?.side === "after" ? 1 : 0), 0, node);
    if (input.node.type === "task") {
      const task = input.node.task;
      const workspaceKey = resolveWorkspaceKey(task);
      if (manual) this.markOrganized(workspaceKey, task.taskId);
      this.db
        .prepare("DELETE FROM task_group_members WHERE workspace_key=? AND task_id=?")
        .run(workspaceKey, task.taskId);
      if (input.groupId) {
        const now = this.now();
        this.db
          .prepare(`INSERT INTO task_group_members(group_id,workspace_key,workspace_path,workspace_identity,task_id,sort_order,added_at,created_at,updated_at)
          VALUES(?,?,?,?,?,0,?,?,?)`)
          .run(
            input.groupId,
            workspaceKey,
            task.workspacePath,
            task.workspaceIdentity ?? null,
            task.taskId,
            now,
            now,
            now,
          );
      }
    }
    this.writeOrder(destination, input.groupId);
  }
  admit(
    tasks: GroupTaskFact[],
    placement?: Parameters<ITaskGroupService["admit"]>[0]["placement"],
  ): void {
    this.transaction(() => {
      // 批量首次发现按创建时间从旧到新写入顶部；以后活动更新不重排已登记节点。
      for (const task of [...tasks].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))) {
        const workspaceKey = resolveWorkspaceKey(task),
          key = groupTaskKey(task);
        if (task.deleted) {
          this.db
            .prepare("DELETE FROM task_group_members WHERE workspace_key=? AND task_id=?")
            .run(workspaceKey, task.taskId);
          this.db
            .prepare(
              "DELETE FROM task_group_view_node_orders WHERE node_type='task' AND node_key=?",
            )
            .run(key);
          // 删除事实可能晚到；保留登记墓碑，后续缺少 deleted 的投影不能重新入组。
          this.markOrganized(workspaceKey, task.taskId);
          continue;
        }
        let admission = this.db
          .prepare("SELECT * FROM task_group_admissions WHERE workspace_key=? AND task_id=?")
          .get(workspaceKey, task.taskId) as unknown as Admission | undefined;
        if (!admission) {
          const legacy =
            this.parent(task) !== null ||
            Boolean(
              this.db
                .prepare(
                  "SELECT 1 FROM task_group_view_node_orders WHERE node_type='task' AND node_key=?",
                )
                .get(key),
            );
          this.db
            .prepare(
              "INSERT INTO task_group_admissions(workspace_key,task_id,user_organized) VALUES(?,?,?)",
            )
            .run(workspaceKey, task.taskId, legacy ? 1 : 0);
          admission = { system_kind: null, creation_id: null, user_organized: legacy ? 1 : 0 };
          if (!legacy) {
            // 首次发现只写一个顶层位置，避免大库启动时逐条重排造成平方级写放大。
            const order = Number(
              this.db
                .prepare(
                  "SELECT coalesce(min(sort_order),0)-1 AS n FROM task_group_view_node_orders",
                )
                .get()?.n,
            );
            const now = this.now();
            this.db
              .prepare(
                "INSERT INTO task_group_view_node_orders(node_type,node_key,sort_order,created_at,updated_at) VALUES('task',?,?,?,?)",
              )
              .run(key, order, now, now);
          }
        }
        const systemKind = task.cronAutomationId ? "cron" : task.offPeakTaskId ? "off-peak" : null;
        if (systemKind && admission.system_kind === null) {
          this.db
            .prepare(
              "UPDATE task_group_admissions SET system_kind=? WHERE workspace_key=? AND task_id=?",
            )
            .run(systemKind, workspaceKey, task.taskId);
          // 首次类型确认才入组；不能把读列表变成重复覆盖用户整理的“自愈”。
          if (!admission.user_organized && !task.archived && !this.parent(task)) {
            const id = systemKind === "cron" ? CRON_DEFAULT_GROUP_ID : OFF_PEAK_DEFAULT_GROUP_ID;
            if (!this.hasGroup(id)) {
              const now = this.now();
              this.db
                .prepare("INSERT INTO task_groups VALUES(?,?,?,?,?)")
                .run(id, systemKind, systemKind === "cron" ? "blue" : "purple", now, now);
              this.writeOrder(
                [
                  { type: "group", key: id },
                  ...this.children(null).filter((node) => node.key !== id),
                ],
                null,
              );
            }
            this.moveInside(
              { node: { type: "task", task }, sourceGroupId: null, groupId: id },
              false,
            );
          }
        }
        if (placement && groupTaskKey(placement.task) === key && admission.creation_id === null) {
          if (!admission.user_organized)
            this.moveInside(
              {
                node: { type: "task", task },
                sourceGroupId: this.parent(task),
                groupId:
                  placement.groupId && this.hasGroup(placement.groupId) ? placement.groupId : null,
              },
              true,
            );
          this.db
            .prepare(
              "UPDATE task_group_admissions SET creation_id=? WHERE workspace_key=? AND task_id=?",
            )
            .run(placement.creationId, workspaceKey, task.taskId);
        }
      }
    });
  }
}
