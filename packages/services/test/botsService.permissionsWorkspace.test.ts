import { describe, expect, it } from "vitest";
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
          allowedWorkspaces: ["ssh://host/tmp/workspace"],
        },
      ],
    });
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "secret-1": "secret" }),
      legacyTaskService: f.createLegacyTaskService(),
      settingService: f.createSettingService({
        lastWorkspaceSession: [
          { kind: "remote", workspacePath: "/tmp/workspace", workspaceIdentity: "ssh://host/tmp/workspace" },
          { kind: "local", workspacePath: "/tmp/other" },
        ],
      }),
      repo: repo as never,
    });

    const replies = await service.handleInboundMessage({ botId: "webhook-1", text: "/workspace", actor });

    expect(replies[0]?.selection?.options.map((option) => option.id)).toEqual(["ssh://host/tmp/workspace"]);
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

    const replies = await service.handleInboundMessage({ botId: "webhook-1", text: "/workspace 1", actor });

    expect(replies[0]?.text).toContain("工作区: workspace");
    expect(replies[0]?.text).toContain("任务: 草稿");
    expect((await repo.readState()).bots["webhook-1"]).toMatchObject({
      workspacePath: "/tmp/workspace",
      workspaceIdentity: "ssh://host/tmp/workspace",
      workspaceId: "ssh://host/tmp/workspace",
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

    const replies = await service.handleInboundMessage({ botId: "webhook-1", text: "/model gpt-5.4", actor });

    expect(replies[0]?.text).toContain("未启用");
    expect((await repo.readConfig()).bots[0]?.currentOptions.model).toBeUndefined();
    service.disposeAll();
  });
});
