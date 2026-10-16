import { describe, expect, it } from "vitest";
import * as f from "./botsService.fixtures.js";

const actor = {
  provider: "webhook" as const,
  botId: "webhook-1",
  providerUserId: "user-1",
  chatType: "private" as const,
};

describe("botsService status", () => {
  it("reports bot counts and runtime contexts", async () => {
    const repo = f.createMemoryRepo(f.baseConfig);
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "secret-1": "secret" }),
      legacyTaskService: f.createLegacyTaskService(),
      repo: repo as never,
    });

    const code = await service.createBindCode({ botId: "webhook-1" });
    await service.handleInboundMessage({ botId: "webhook-1", text: `/bind ${code.code}`, actor });
    await service.handleInboundMessage({ botId: "webhook-1", text: "/new", actor });

    await expect(service.getStatus()).resolves.toMatchObject({
      botsCount: 1,
      enabledBotsCount: 1,
      contextsCount: 1,
    });
    await expect(service.getBotStates()).resolves.toMatchObject([
      {
        botId: "webhook-1",
        mode: "draft",
        activeTaskId: null,
      },
    ]);
    service.disposeAll();
  });

  it("returns user-facing /status for a bound bot", async () => {
    const repo = f.createMemoryRepo(f.baseConfig);
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "secret-1": "secret" }),
      legacyTaskService: f.createLegacyTaskService(),
      repo: repo as never,
    });

    const code = await service.createBindCode({ botId: "webhook-1" });
    await service.handleInboundMessage({ botId: "webhook-1", text: `/bind ${code.code}`, actor });
    const replies = await service.handleInboundMessage({
      botId: "webhook-1",
      text: "/status",
      actor,
    });

    expect(replies[0]?.text).toContain("工作区");
    expect(replies[0]?.text).not.toContain("Provider:");
    expect(replies[0]?.text).toContain("模型: default");
    service.disposeAll();
  });

  it("returns English /status when the app locale is en-US", async () => {
    const repo = f.createMemoryRepo(f.baseConfig);
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "secret-1": "secret" }),
      legacyTaskService: f.createLegacyTaskService(),
      settingService: f.createSettingService({
        locale: "en-US",
        lastWorkspaceSession: [
          {
            kind: "remote",
            workspacePath: "/tmp/workspace",
            workspaceIdentity: "ssh://host/tmp/workspace",
          },
        ],
      }),
      repo: repo as never,
    });

    const code = await service.createBindCode({ botId: "webhook-1" });
    await service.handleInboundMessage({ botId: "webhook-1", text: `/bind ${code.code}`, actor });
    const replies = await service.handleInboundMessage({
      botId: "webhook-1",
      text: "/status",
      actor,
    });

    expect(replies[0]?.text).toContain("Workspace: workspace");
    expect(replies[0]?.text).toContain("Model: default");
    expect(replies[0]?.text).toContain("Task: draft");
    service.disposeAll();
  });

  it("reports active task model from task/config options", async () => {
    const repo = f.createMemoryRepo(
      {
        ...f.baseConfig,
        bots: [
          {
            ...f.baseConfig.bots[0]!,
            providerUserId: "user-1",
          },
        ],
      },
      {
        version: 3,
        bots: {
          "webhook-1": {
            botId: "webhook-1",
            workspacePath: "/tmp/workspace",
            workspaceIdentity: "ssh://host/tmp/workspace",
            workspaceId: "ssh://host/tmp/workspace",
            mode: "task",
            activeTaskId: "task-1",
            updatedAt: Date.now(),
          },
        },
      },
    );
    const legacyTaskService = f.createLegacyTaskService();
    legacyTaskService.listTasks = async () => [
      {
        taskId: "task-1",
        title: "Active task",
        workspacePath: "/tmp/workspace",
        workspaceIdentity: "ssh://host/tmp/workspace",
        provider: "codex",
        model: "meta-model",
        status: "completed",
        traceId: "trace",
        createdAt: 1,
        updatedAt: 1,
        mode: "default",
      },
    ];
    legacyTaskService.getTaskConfigOptions = async () => [
      {
        id: "model",
        category: "model",
        type: "select",
        currentValue: "gpt-5.4",
        options: [{ value: "gpt-5.4", name: "GPT-5.4" }],
      },
    ];
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "secret-1": "secret" }),
      legacyTaskService,
      repo: repo as never,
    });

    const replies = await service.handleInboundMessage({
      botId: "webhook-1",
      text: "/status",
      actor,
    });

    expect(replies[0]?.text).not.toContain("Provider:");
    expect(replies[0]?.text).toContain("模型: gpt-5.4");
    service.disposeAll();
  });

  it("renders custom provider display name in status model", async () => {
    const providerId = "672a331d-423f-4c83-ab40-93288d9655a6";
    const repo = f.createMemoryRepo(
      {
        ...f.baseConfig,
        bots: [
          {
            ...f.baseConfig.bots[0]!,
            providerUserId: "user-1",
          },
        ],
      },
      {
        version: 3,
        bots: {
          "webhook-1": {
            botId: "webhook-1",
            workspacePath: "/tmp/workspace",
            workspaceIdentity: "ssh://host/tmp/workspace",
            workspaceId: "ssh://host/tmp/workspace",
            mode: "task",
            activeTaskId: "task-1",
            updatedAt: Date.now(),
          },
        },
      },
    );
    const legacyTaskService = f.createLegacyTaskService();
    legacyTaskService.listTasks = async () => [
      {
        taskId: "task-1",
        title: "Active task",
        workspacePath: "/tmp/workspace",
        workspaceIdentity: "ssh://host/tmp/workspace",
        provider: "glm",
        model: `${providerId}/deepseek-v4-flash`,
        status: "completed",
        traceId: "trace",
        createdAt: 1,
        updatedAt: 1,
        mode: "yolo",
      },
    ];
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "secret-1": "secret" }),
      legacyTaskService,
      modelSelectionService: f.createModelSelectionService([
        {
          id: providerId,
          name: "DeepSeek",
          endpoints: { baseURL: "https://example.com", paths: {} },
          apiKey: "sk-test",
          models: ["deepseek-v4-flash"],
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
      repo: repo as never,
    });

    const replies = await service.handleInboundMessage({
      botId: "webhook-1",
      text: "/status",
      actor,
    });

    expect(replies[0]?.text).toContain("模型: DeepSeek/deepseek-v4-flash");
    expect(replies[0]?.text).not.toContain(`${providerId}/deepseek-v4-flash`);
    service.disposeAll();
  });
});
