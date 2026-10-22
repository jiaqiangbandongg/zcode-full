import { seedTaskIndex } from "./helpers/taskIndexFixture.js";
// D48 一等行打点：offPeakTaskId 作为持久 task meta 字段的仓库契约（MR1，无 UI 行为变化）。
// 镜像 cronAutomationId 的三条不变量：meta_json 为准 + 索引列兜底、运行态快照不带标记时
// 保全已有值、bootstrap 幂等回填存量 off-peak 会话。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { setDataBaseDir } from "#src/paths.js";
import { TaskGroupRepository } from "#src/task-groups/index.js";
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
    provider: "glm",
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
  it("seedTaskIndex 持久化 offPeakTaskId 并投影到索引列", async () => {
    await seedTaskIndex(repo, { meta: task({ taskId: "s-1", offPeakTaskId: "offpeak-1" }) });

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
    await seedTaskIndex(repo, { meta: task({ taskId: "s-2", offPeakTaskId: "offpeak-2" }) });
    // 运行态 protocol snapshot 的 meta 不携带 off-peak 标记；同步不得把归属冲掉。
    await seedTaskIndex(repo, { meta: task({ taskId: "s-2" }) });

    const meta = await repo.getTaskMeta({
      workspacePath: "/workspace/project",
      taskId: "s-2",
    });
    expect(meta?.offPeakTaskId).toBe("offpeak-2");
  });

  it("meta_json 缺字段时以索引列兜底（backfill 只写列即可生效）", async () => {
    await seedTaskIndex(repo, { meta: task({ taskId: "s-3" }) });
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
    await seedTaskIndex(repo, { meta: task({ taskId: "s-legacy" }) });
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
    await seedTaskIndex(repo, { meta: task({ taskId: "s-4", offPeakTaskId: "offpeak-explicit" }) });
    await seedTaskIndex(repo, { meta: task({ taskId: "s-plain" }) });
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

describe("TaskIndexRepo off-peak project ownership", () => {
  it("off-peak 首次标记加入系统组，不改变项目归属，重复同步不复活手动移出", async () => {
    const projectRepo = await repo.getProjectRepository();
    const project = projectRepo.saveProject({ roots: ["/workspace/project"] });
    const meta = task({ taskId: "project-offpeak" });
    projectRepo.reserveCreatedTask({ task: meta, projectId: project.id });
    await repo.applyCliFacts({ meta, lastOutcome: "completed" });
    await repo.updateTaskPresentation({ ...meta, presentation: { offPeakTaskId: "offpeak-1" } });
    expect(projectRepo.readTree().tasks[0]).toMatchObject({
      projectId: project.id,
      offPeakTaskId: "offpeak-1",
    });
    expect(getRepoDatabase(repo).prepare("SELECT count(*) AS n FROM task_groups").get()?.n).toBe(1);
    expect(
      getRepoDatabase(repo).prepare("SELECT count(*) AS n FROM task_group_members").get()?.n,
    ).toBe(1);
    const groups = new TaskGroupRepository(await repo.getOrganizationDatabase());
    const groupId = groups.read().members[0]!.groupId;
    groups.move({
      node: { type: "task", task: { ...meta, hostId: "local" } },
      sourceGroupId: groupId,
      groupId: null,
    });
    await repo.updateTaskPresentation({ ...meta, presentation: { offPeakTaskId: "offpeak-1" } });
    expect(groups.read().members).toEqual([]);
    await repo.applyCliDeletion(meta);
    expect(groups.read().order.filter((node) => node.type === "task")).toEqual([]);
  });
});
