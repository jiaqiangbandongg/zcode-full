import { describe, expect, it, vi } from "vitest";
import * as f from "./botsService.fixtures.js";

const actor = {
  provider: "webhook" as const,
  botId: "webhook-1",
  providerUserId: "user-1",
  chatType: "private" as const,
};

async function bind(service: ReturnType<typeof f.createBotsService>) {
  const code = await service.createBindCode({ botId: "webhook-1" });
  await service.handleInboundMessage({ botId: "webhook-1", text: `/bind ${code.code}`, actor });
}

describe("botsService permissions and workspace", () => {
  it("filters workspace selection by allowed workspace key", async () => {
    const repo = f.createMemoryRepo({
      ...f.baseConfig,
      bots: [
        {
          ...f.baseConfig.bots[0]!,
          providerUserId: "user-1",
          allowedWorkspaces: ["remote:server:test-owner:/tmp/workspace"],
        },
      ],
    });
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "secret-1": "secret" }),
      legacyTaskService: f.createLegacyTaskService(),
      settingService: f.createSettingService({
        lastWorkspaceSession: [
          {
            kind: "remote",
            workspacePath: "/tmp/workspace",
            workspaceIdentity: "remote:server:test-owner:/tmp/workspace",
          },
          { kind: "local", workspacePath: "/tmp/other" },
        ],
      }),
      repo: repo as never,
    });

    const replies = await service.handleInboundMessage({
      botId: "webhook-1",
      text: "/workspace",
      actor,
    });

    expect(replies[0]?.selection?.options.map((option) => option.id)).toEqual([
      JSON.stringify(["remote:server:test-owner", "project-0"]),
    ]);
    service.disposeAll();
  });

  it("updates bot-state after /workspace", async () => {
    const repo = f.createMemoryRepo(f.baseConfig);
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "secret-1": "secret" }),
      legacyTaskService: f.createLegacyTaskService(),
      repo: repo as never,
    });
    await bind(service);

    const replies = await service.handleInboundMessage({
      botId: "webhook-1",
      text: "/workspace 1",
      actor,
    });

    expect(replies[0]?.text).toContain("工作区: workspace");
    expect(replies[0]?.text).toContain("任务: 草稿");
    expect((await repo.readState()).bots["webhook-1"]).toMatchObject({
      workspacePath: "/tmp/workspace",
      workspaceIdentity: "remote:server:test-owner:/tmp/workspace",
      workspaceId: JSON.stringify(["remote:server:test-owner", "project-0"]),
      mode: "draft",
      activeTaskId: null,
    });
    service.disposeAll();
  });

  it("does not update disabled command options", async () => {
    const repo = f.createMemoryRepo({
      ...f.baseConfig,
      bots: [
        {
          ...f.baseConfig.bots[0]!,
          providerUserId: "user-1",
          allowedCommands: { ...f.defaultUserCommands, model: false },
        },
      ],
    });
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "secret-1": "secret" }),
      legacyTaskService: f.createLegacyTaskService(),
      repo: repo as never,
    });

    const replies = await service.handleInboundMessage({
      botId: "webhook-1",
      text: "/model gpt-5.4",
      actor,
    });

    expect(replies[0]?.text).toContain("未启用");
    expect((await repo.readConfig()).bots[0]?.currentOptions.model).toBeUndefined();
    service.disposeAll();
  });
});

describe("Bot R3 workspace identity projection", () => {
  it("normalizes legacy context and exact authorization to the same stable Source without path fallback", async () => {
    const legacy = "remote:ssh:source.test:22:dev:/work/project";
    const stable = "remote:server:source-a:/work/project";
    const other = "remote:server:source-b:/work/project";
    const repo = f.createMemoryRepo(
      {
        ...f.baseConfig,
        bots: [{ ...f.baseConfig.bots[0]!, providerUserId: "user-1", allowedWorkspaces: [legacy] }],
      },
      {
        version: 3,
        bots: {
          "webhook-1": {
            botId: "webhook-1",
            workspacePath: "/work/project",
            workspaceIdentity: legacy,
            workspaceId: legacy,
            mode: "task",
            activeTaskId: "old-task",
            updatedAt: 1,
          },
        },
      },
    );
    const resolver = vi.fn(async (target: { workspacePath: string; workspaceIdentity: string }) =>
      target.workspaceIdentity === legacy ? { ...target, workspaceIdentity: stable } : target,
    );
    const service = f.createBotsService({
      ...f.createBotProjectServices([
        { workspacePath: "/work/project", workspaceIdentity: stable },
        { workspacePath: "/work/project", workspaceIdentity: other },
      ]),
      credentialService: f.createCredentialService({ "secret-1": "secret" }),
      legacyTaskService: f.createLegacyTaskService(),
      repo: repo as never,
      settingService: f.createSettingService({
        lastWorkspaceSession: [
          { kind: "remote", workspacePath: "/work/project", workspaceIdentity: legacy },
          { kind: "remote", workspacePath: "/work/project", workspaceIdentity: other },
        ],
      }),
      remoteWorkspaceService: {
        resolveWorkspace: resolver,
        isConnected: async () => false,
        ensureConnected: async () => ({ ok: false }),
      },
    });
    const replies = await service.handleInboundMessage({
      botId: "webhook-1",
      text: "/workspace",
      actor,
    });
    expect(replies[0]?.selection?.options.map((option) => option.id)).toEqual([
      JSON.stringify(["remote:server:source-a", "project-0"]),
    ]);
    expect((await repo.readState()).bots["webhook-1"]).toMatchObject({
      workspaceIdentity: stable,
      workspaceId: JSON.stringify(["remote:server:source-a", "project-0"]),
      activeTaskId: "old-task",
    });
    expect((await repo.readConfig()).bots[0]!.allowedWorkspaces).toEqual([
      JSON.stringify(["remote:server:source-a", "project-0"]),
    ]);
    service.disposeAll();
  });
  it("reads fresh project membership without waiting for a workspace cache TTL", async () => {
    const stable = "remote:server:source-a:/work/project";
    const projects = f.createBotProjectServices([
      { workspacePath: "/work/project", workspaceIdentity: stable },
    ]);
    const readDirectory = projects.remoteProjectService.readDirectory;
    let ready = false;
    projects.remoteProjectService.readDirectory = vi.fn(async () =>
      ready ? readDirectory() : { hosts: [], entries: [] },
    );
    const service = f.createBotsService({
      ...projects,
      credentialService: f.createCredentialService(),
      legacyTaskService: f.createLegacyTaskService(),
      repo: f.createMemoryRepo(f.baseConfig) as never,
    });
    expect(await service.listWorkspaceRefs()).toEqual([]);
    ready = true;
    expect((await service.listWorkspaceRefs())[0]?.workspaceIdentity).toBe(stable);
    service.disposeAll();
  });
  it("deduplicates a current custom workspace id by workspace identity", async () => {
    const stable = "remote:server:source-a:/work/project";
    const service = f.createBotsService({
      ...f.createBotProjectServices([
        { workspacePath: "/work/project", workspaceIdentity: stable },
      ]),
      credentialService: f.createCredentialService(),
      legacyTaskService: f.createLegacyTaskService(),
      repo: f.createMemoryRepo(f.baseConfig) as never,
      settingService: f.createSettingService({
        lastWorkspaceSession: [
          { kind: "remote", workspacePath: "/work/project", workspaceIdentity: stable },
        ],
      }),
      remoteWorkspaceService: {
        resolveWorkspace: async (target) => target,
        isConnected: async () => false,
        ensureConnected: async () => ({ ok: false }),
      },
    });
    const refs = await service.listWorkspaceRefs({
      currentWorkspace: {
        id: "custom-id",
        label: "Custom",
        workspacePath: "/work/project",
        workspaceIdentity: stable,
      },
    });
    expect(refs.map((ref) => ref.id)).toEqual([
      JSON.stringify(["remote:server:source-a", "project-0"]),
    ]);
    service.disposeAll();
  });
});
