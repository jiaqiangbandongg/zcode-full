// D48 一等行打点：offPeakTaskId 作为持久 task meta 字段的仓库契约（MR1，无 UI 行为变化）。
// 镜像 cronAutomationId 的三条不变量：meta_json 为准 + 索引列兜底、运行态快照不带标记时
// 保全已有值、bootstrap 幂等回填存量 off-peak 会话。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { setDataBaseDir } from "#src/paths.js";
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";
import { OffPeakTaskRepo } from "#src/session/offPeakTaskRepo.js";

let repo: TaskIndexRepo;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "zcode-task-index-off-peak-marker-"));
  setDataBaseDir(tempDir);
  repo = new TaskIndexRepo();
});

afterEach(async () => {
  repo.close();
  setDataBaseDir(null);
  // Windows 需要等待 SQLite 释放文件句柄，避免临时目录清理出现 EPERM。
  await new Promise((resolve) => setTimeout(resolve, 50));
  rmSync(tempDir, { recursive: true, force: true });
});

function task(params: { taskId: string; offPeakTaskId?: string }): ZCodeTaskMeta {
  return {
    taskId: params.taskId,
    traceId: `trace-${params.taskId}`,
    title: params.taskId,
    workspacePath: "/workspace/project",
    createdAt: 10,
    updatedAt: 20,
    mode: "default",
    status: "running",
    ...(params.offPeakTaskId ? { offPeakTaskId: params.offPeakTaskId } : {}),
  };
}

function getRepoDatabase(target: TaskIndexRepo): {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
  };
} {
  return (
    target as unknown as {
      getDatabase(): {
        prepare(sql: string): {
          run(...params: unknown[]): unknown;
          get(...params: unknown[]): unknown;
        };
      };
    }
  ).getDatabase();
}

describe("TaskIndexRepo off-peak marker (D48)", () => {
  it("syncTaskMeta 持久化 offPeakTaskId 并投影到索引列", async () => {
    await repo.syncTaskMeta({ meta: task({ taskId: "s-1", offPeakTaskId: "offpeak-1" }) });

    const meta = await repo.getTaskMeta({
      workspacePath: "/workspace/project",
      taskId: "s-1",
    });
    expect(meta?.offPeakTaskId).toBe("offpeak-1");

    const row = getRepoDatabase(repo)
      .prepare(`SELECT off_peak_task_id FROM tasks WHERE task_id = ?`)
      .get("s-1") as { off_peak_task_id: string | null };
    expect(row.off_peak_task_id).toBe("offpeak-1");
  });

  it("运行态快照不带标记时保全已有 offPeakTaskId", async () => {
    await repo.syncTaskMeta({ meta: task({ taskId: "s-2", offPeakTaskId: "offpeak-2" }) });
    // 运行态 protocol snapshot 的 meta 不携带 off-peak 标记；同步不得把归属冲掉。
    await repo.syncTaskMeta({ meta: task({ taskId: "s-2" }) });

    const meta = await repo.getTaskMeta({
      workspacePath: "/workspace/project",
      taskId: "s-2",
    });
    expect(meta?.offPeakTaskId).toBe("offpeak-2");
  });

  it("meta_json 缺字段时以索引列兜底（backfill 只写列即可生效）", async () => {
    await repo.syncTaskMeta({ meta: task({ taskId: "s-3" }) });
    getRepoDatabase(repo)
      .prepare(`UPDATE tasks SET off_peak_task_id = ? WHERE task_id = ?`)
      .run("offpeak-3", "s-3");

    const meta = await repo.getTaskMeta({
      workspacePath: "/workspace/project",
      taskId: "s-3",
    });
    expect(meta?.offPeakTaskId).toBe("offpeak-3");
  });

  it("bootstrap 幂等回填存量 off-peak 会话的标记", async () => {
    // 存量形态：off_peak_tasks 已绑定 session，但 tasks 行诞生于打点之前、无标记。
    // 先做一次 repo 操作触发懒初始化，getRepoDatabase 才能拿到句柄。
    await repo.syncTaskMeta({ meta: task({ taskId: "s-legacy" }) });
    const offPeakRepo = new OffPeakTaskRepo();
    await offPeakRepo.create(
      {
        title: "legacy",
        prompt: "legacy",
        permissionMode: "build",
        workspacePath: "/workspace/project",
        modelSelection: { providerId: "account:zai-offpeak-idle-plan", modelId: "GLM-5.2" },
      },
      { offPeakTaskId: "offpeak-legacy" },
    );
    getRepoDatabase(repo)
      .prepare(`UPDATE off_peak_tasks SET session_id = ? WHERE off_peak_task_id = ?`)
      .run("s-legacy", "offpeak-legacy");
    getRepoDatabase(repo)
      .prepare(`UPDATE tasks SET off_peak_task_id = NULL WHERE task_id = ?`)
      .run("s-legacy");
    repo.close();

    // 重新 bootstrap（等价于升级后首次启动）：回填必须命中且可重复执行。
    repo = new TaskIndexRepo();
    const meta = await repo.getTaskMeta({
      workspacePath: "/workspace/project",
      taskId: "s-legacy",
    });
    expect(meta?.offPeakTaskId).toBe("offpeak-legacy");

    offPeakRepo.close();
  });

  it("回填不覆盖已有标记且对无关任务无副作用", async () => {
    // 已有显式标记的任务（值不同）与普通任务都不得被回填改写。
    await repo.syncTaskMeta({ meta: task({ taskId: "s-4", offPeakTaskId: "offpeak-explicit" }) });
    await repo.syncTaskMeta({ meta: task({ taskId: "s-plain" }) });
    const offPeakRepo = new OffPeakTaskRepo();
    await offPeakRepo.create(
      {
        title: "other",
        prompt: "other",
        permissionMode: "build",
        workspacePath: "/workspace/project",
        modelSelection: { providerId: "account:zai-offpeak-idle-plan", modelId: "GLM-5.2" },
      },
      { offPeakTaskId: "offpeak-other" },
    );
    getRepoDatabase(repo)
      .prepare(`UPDATE off_peak_tasks SET session_id = ? WHERE off_peak_task_id = ?`)
      .run("s-4", "offpeak-other");
    repo.close();

    repo = new TaskIndexRepo();
    const explicit = await repo.getTaskMeta({
      workspacePath: "/workspace/project",
      taskId: "s-4",
    });
    expect(explicit?.offPeakTaskId).toBe("offpeak-explicit");
    const plain = await repo.getTaskMeta({
      workspacePath: "/workspace/project",
      taskId: "s-plain",
    });
    expect(plain?.offPeakTaskId).toBeUndefined();

    offPeakRepo.close();
  });
});

// D48-A：首次获得标记时归入闲时系统分组（照抄 ensureCronGroupMembership），
// 以及 bootstrap 对 MR1 列回填存量的成员关系补齐。
describe("TaskIndexRepo off-peak group membership (D48-A)", () => {
  const OFF_PEAK_GROUP_ID = "zcode-default-group-off-peak";

  function membershipRow(taskId: string): { group_id: string } | undefined {
    return getRepoDatabase(repo)
      .prepare(`SELECT group_id FROM task_group_members WHERE task_id = ?`)
      .get(taskId) as { group_id: string } | undefined;
  }

  it("首次获得标记时写入分组行、顶层排序与成员关系", async () => {
    await repo.syncTaskMeta({ meta: task({ taskId: "m-1", offPeakTaskId: "offpeak-m1" }) });

    const group = getRepoDatabase(repo)
      .prepare(`SELECT group_id, title, color FROM task_groups WHERE group_id = ?`)
      .get(OFF_PEAK_GROUP_ID) as { title: string; color: string } | undefined;
    expect(group?.title).toBe("off-peak");
    expect(group?.color).toBe("purple");
    expect(membershipRow("m-1")?.group_id).toBe(OFF_PEAK_GROUP_ID);
    const order = getRepoDatabase(repo)
      .prepare(
        `SELECT node_key FROM task_group_view_node_orders WHERE node_type = 'group' AND node_key = ?`,
      )
      .get(OFF_PEAK_GROUP_ID);
    expect(order).toBeTruthy();
  });

  it("用户已手动分组的任务不被拖回闲时组", async () => {
    await repo.syncTaskMeta({ meta: task({ taskId: "m-2" }) });
    getRepoDatabase(repo)
      .prepare(
        `INSERT INTO task_groups (group_id, title, color, created_at, updated_at)
         VALUES ('custom-group', 'Custom', 'green', 1, 1)`,
      )
      .run();
    getRepoDatabase(repo)
      .prepare(
        `INSERT INTO task_group_members (
          group_id, workspace_key, workspace_path, workspace_identity, task_id,
          sort_order, added_at, created_at, updated_at
        ) VALUES ('custom-group', '/workspace/project', '/workspace/project', NULL, 'm-2', NULL, 1, 1, 1)`,
      )
      .run();
    // 首次获得标记：OR IGNORE 不得覆盖用户手动整理的成员关系。
    await repo.syncTaskMeta({ meta: task({ taskId: "m-2", offPeakTaskId: "offpeak-m2" }) });

    expect(membershipRow("m-2")?.group_id).toBe("custom-group");
  });

  it("bootstrap 为 MR1 列回填的存量标记行补成员关系", async () => {
    // 存量形态：标记只在投影列（MR1 回填），meta_json 无字段、成员关系从未写入。
    await repo.syncTaskMeta({ meta: task({ taskId: "m-3" }) });
    getRepoDatabase(repo)
      .prepare(`UPDATE tasks SET off_peak_task_id = ? WHERE task_id = ?`)
      .run("offpeak-m3", "m-3");
    expect(membershipRow("m-3")).toBeUndefined();
    repo.close();

    repo = new TaskIndexRepo();
    await repo.getTaskMeta({ workspacePath: "/workspace/project", taskId: "m-3" });
    expect(membershipRow("m-3")?.group_id).toBe(OFF_PEAK_GROUP_ID);
  });

  it("远程 workspace 存量行不回填成员关系（暂不支持远程闲时任务）", async () => {
    // CR-01 场景：存量远程行 workspace_key 已是远端 identity，但 workspace_identity
    // 列缺失。若回填不跳过，会用 workspacePath 重算出本地 key 造成成员关系串写。
    const remoteKey = "remote:ssh:10.0.0.8:2222:dev:/workspace/project";
    await repo.syncTaskMeta({ meta: task({ taskId: "m-remote" }) });
    getRepoDatabase(repo)
      .prepare(
        `UPDATE tasks SET workspace_key = ?, workspace_identity = NULL, off_peak_task_id = ?
         WHERE task_id = ?`,
      )
      .run(remoteKey, "offpeak-remote", "m-remote");
    repo.close();

    repo = new TaskIndexRepo();
    // 触发懒初始化让 bootstrap 回填跑完；断言既无远端 key 成员，也无串写的本地 key 成员。
    await repo.getTaskMeta({ workspacePath: "/workspace/project", taskId: "m-remote" });
    expect(membershipRow("m-remote")).toBeUndefined();
  });

  it("远程 workspace 会话首次获得标记也不归组（暂不支持远程闲时任务）", async () => {
    await repo.syncTaskMeta({
      meta: {
        ...task({ taskId: "m-remote-sync", offPeakTaskId: "offpeak-remote-sync" }),
        workspaceIdentity: "remote:ssh:10.0.0.8:2222:dev:/workspace/project",
      },
    });

    expect(membershipRow("m-remote-sync")).toBeUndefined();
  });
});
