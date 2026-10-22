import { expect, it, vi } from "vitest";
import * as f from "./botsService.fixtures.js";
import type { VirtualProject, ProjectTask } from "../src/project/contract.js";

const actor = {
  provider: "webhook" as const,
  botId: "webhook-1",
  providerUserId: "user-1",
  chatType: "private" as const,
};
const config = { ...f.baseConfig, bots: [{ ...f.baseConfig.bots[0]!, providerUserId: "user-1" }] };
function project(id: string, roots = ["/first", "/extra"]): VirtualProject {
  return {
    id,
    hostId: "local",
    name: id,
    roots: roots.map((rootPath, position) => ({ rootPath, position, isPrimary: position === 0 })),
    nameOverridden: false,
    position: 0,
    pinned: false,
    deleted: false,
    createdAt: 1,
    updatedAt: 1,
  };
}
function setup(initial = [project("p")], state?: Parameters<typeof f.createMemoryRepo>[1]) {
  let projects = initial;
  let tasks: ProjectTask[] = [];
  const repo = f.createMemoryRepo(config, state);
  const task = f.createLegacyTaskService();
  const prepareSession = vi.fn(async (input?: { projectId?: string }) => {
    const selected = projects.find((item) => item.id === input?.projectId);
    if (!selected) throw new Error("project missing");
    return {
      projectId: selected.id,
      workspacePath: selected.roots[0]?.rootPath ?? "/allocated",
      additionalDirectories: selected.roots.slice(1).map((root) => root.rootPath),
    };
  });
  const service = f.createBotsService({
    repo: repo as never,
    credentialService: f.createCredentialService({ "secret-1": "secret" }),
    zcodeTaskService: task,
    projectService: {
      readProjects: async () => projects,
      prepareSession,
      readTree: async () => ({ projects, tasks }),
    },
  } as Parameters<typeof f.createBotsService>[0]);
  return {
    service,
    repo,
    task,
    prepareSession,
    setTasks: (next: ProjectTask[]) => {
      tasks = next;
      vi.mocked(task.listTasks).mockResolvedValue(next);
    },
    setProjects: (next: VirtualProject[]) => {
      projects = next;
    },
    send: (text: string) => service.handleInboundMessage({ botId: "webhook-1", actor, text }),
  };
}
it("候选按项目区分相同 cwd，并且不从历史 tab 造候选", async () => {
  const s = setup([project("one"), project("two"), project("empty", [])]);
  try {
    const refs = await s.service.listWorkspaceRefs({
      currentWorkspace: { id: "tab", label: "tab", workspacePath: "/tab" },
    });
    expect(refs.map((ref) => ref.label)).toEqual(["one", "two", "empty"]);
    expect(new Set(refs.map((ref) => ref.id)).size).toBe(3);
    expect(s.prepareSession).not.toHaveBeenCalled();
  } finally {
    s.service.disposeAll();
  }
});
it("同 cwd 其他项目任务不进入 Bot 选择，旧菜单被移动后不能绕过归属校验", async () => {
  const s = setup([project("p"), project("other")]);
  const row = (taskId: string, projectId: string): ProjectTask => ({
    taskId,
    projectId,
    hostId: "local",
    title: taskId,
    provider: "zcode",
    workspacePath: "/first",
    archived: false,
    pinned: false,
  });
  try {
    s.setTasks([row("allowed", "p"), row("elsewhere", "other")]);
    const menu = await s.send("/task");
    expect(menu[0]?.selection?.options.map((option) => option.id)).toEqual(["allowed"]);
    s.setTasks([row("allowed", "other"), row("elsewhere", "other")]);
    await s.send("/task allowed");
    expect((await s.repo.readState()).bots["webhook-1"]?.activeTaskId).toBeNull();
  } finally {
    s.service.disposeAll();
  }
});
it("/task 切换保持项目授权 ID，之后 /new 仍保留原执行快照", async () => {
  const s = setup();
  try {
    const refs = await s.service.listWorkspaceRefs();
    await s.repo.writeConfig({
      ...config,
      bots: [{ ...config.bots[0]!, allowedWorkspaces: [refs[0]!.id] }],
    });
    s.setTasks([
      {
        taskId: "existing",
        projectId: "p",
        hostId: "local",
        title: "existing",
        provider: "zcode",
        workspacePath: "/first",
        archived: false,
        pinned: false,
      },
    ]);
    await s.send("/task existing");
    expect((await s.repo.readState()).bots["webhook-1"]?.workspaceId).toBe(refs[0]!.id);
    await s.send("/new");
    expect((await s.repo.readState()).bots["webhook-1"]).toMatchObject({
      mode: "draft",
      activeTaskId: null,
      additionalDirectories: ["/extra"],
    });
  } finally {
    s.service.disposeAll();
  }
});
it("首次绑定持久化目录，roots 编辑及 /new 后新建仍使用同一快照", async () => {
  const s = setup();
  try {
    await s.send("/status");
    expect((await s.repo.readState()).bots["webhook-1"]).toMatchObject({
      projectId: "p",
      hostId: "local",
      workspacePath: "/first",
      additionalDirectories: ["/extra"],
    });
    s.setProjects([project("p", ["/changed", "/changed-extra"])]);
    await s.send("/new");
    await s.send("hello");
    expect(s.task.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "p",
        workspacePath: "/first",
        additionalDirectories: ["/extra"],
      }),
    );
    expect(s.prepareSession).toHaveBeenCalledTimes(1);
  } finally {
    s.service.disposeAll();
  }
});
it("旧 context cwd 不追随主要目录；明确 NULL 交接后不再次归入", async () => {
  const s = setup([project("one"), project("two")], {
    version: 3,
    bots: {
      "webhook-1": {
        botId: "webhook-1",
        workspacePath: "/first",
        mode: "draft",
        activeTaskId: null,
        updatedAt: 1,
      },
    },
  });
  try {
    await s.send("/status");
    expect((await s.repo.readState()).bots["webhook-1"]).toMatchObject({
      hostId: "local",
      projectId: null,
      workspacePath: "/first",
      additionalDirectories: [],
    });
    s.setProjects([project("one")]);
    await s.send("/status");
    expect((await s.repo.readState()).bots["webhook-1"]?.projectId).toBeNull();
    expect(s.prepareSession).not.toHaveBeenCalled();
  } finally {
    s.service.disposeAll();
  }
});
it("两个 Bot 同时创建绑定不能用整份旧 state 覆盖对方", async () => {
  const other = { ...config.bots[0]!, id: "webhook-2", providerUserId: "user-2" };
  const repo = f.createMemoryRepo({ ...config, bots: [...config.bots, other] });
  const readState = repo.readState;
  // 模拟真实 JSON reader 的独立快照，不能让共享对象引用掩盖丢更新。
  repo.readState = async () => structuredClone(await readState());
  const service = f.createBotsService({
    repo: repo as never,
    credentialService: f.createCredentialService({ "secret-1": "secret" }),
    runStartupBackgroundTasks: false,
  });
  try {
    const replies = await Promise.all(
      ["webhook-1", "webhook-2"].map((botId, index) =>
        service.handleInboundMessage({
          botId,
          actor: { ...actor, botId, providerUserId: `user-${index + 1}` },
          text: "/status",
        }),
      ),
    );
    expect(replies.every((reply) => reply[0]?.text?.includes("工作区"))).toBe(true);
    expect(Object.keys((await repo.readState()).bots).sort()).toEqual(["webhook-1", "webhook-2"]);
  } finally {
    service.disposeAll();
  }
});

it("旧远端 canonical 通过入口交接到稳定持库 host，保留执行 identity", async () => {
  const fixture = f.createBotProjectServices();
  const readDirectory = fixture.remoteProjectService.readDirectory;
  const legacyIdentity = "remote:ssh:old:22:user:/tmp/workspace";
  const repo = f.createMemoryRepo(config, {
    version: 3,
    bots: {
      "webhook-1": {
        botId: "webhook-1",
        workspacePath: "/tmp/workspace",
        workspaceIdentity: legacyIdentity,
        mode: "draft",
        activeTaskId: null,
        updatedAt: 1,
      },
    },
  });
  const service = f.createBotsService({
    ...fixture,
    repo: repo as never,
    credentialService: f.createCredentialService({ "secret-1": "secret" }),
    remoteProjectService: {
      readDirectory: async () => {
        const directory = await readDirectory();
        return {
          ...directory,
          entries: directory.entries.map((entry) => ({
            ...entry,
            legacyWorkspace: {
              kind: "remote" as const,
              workspacePath: "/tmp/workspace",
              workspaceIdentity: legacyIdentity,
              target: { kind: "ssh" as const, host: "old", port: 22, username: "user" },
              lastOpenedAt: 1,
            },
          })),
        };
      },
    },
  });
  try {
    await service.handleInboundMessage({ botId: "webhook-1", actor, text: "/status" });
    expect((await repo.readState()).bots["webhook-1"]).toMatchObject({
      hostId: "remote:server:test-owner",
      projectId: "project-0",
      workspaceIdentity: legacyIdentity,
      workspacePath: "/tmp/workspace",
      additionalDirectories: [],
    });
  } finally {
    service.disposeAll();
  }
});
it("远端项目移除重加后不能接受旧 prepareSession 结果", async () => {
  const fixture = f.createBotProjectServices();
  let generation = "first";
  const repo = f.createMemoryRepo(config);
  const prepare = fixture.projectService.prepareSession;
  const readDirectory = fixture.remoteProjectService.readDirectory;
  const service = f.createBotsService({
    ...fixture,
    repo: repo as never,
    credentialService: f.createCredentialService({ "secret-1": "secret" }),
    projectService: {
      ...fixture.projectService,
      prepareSession: async (input) => {
        const result = await prepare(input);
        generation = "readded";
        return result;
      },
    },
    remoteProjectService: {
      readDirectory: async () => {
        const directory = await readDirectory();
        return {
          hosts: directory.hosts.map((host) => ({ ...host, membershipId: generation })),
          entries: directory.entries.map((entry) => ({ ...entry, id: generation })),
        };
      },
    },
  });
  try {
    await service
      .handleInboundMessage({ botId: "webhook-1", actor, text: "/status" })
      .catch(() => undefined);
    expect((await repo.readState()).bots["webhook-1"]).toBeUndefined();
  } finally {
    service.disposeAll();
  }
});
