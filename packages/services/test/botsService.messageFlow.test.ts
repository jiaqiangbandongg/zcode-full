import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import { encodeCustomModelValue, type BotsStateFile, type ZCodeStreamEvent } from "@zcode/shared";
import * as f from "./botsService.fixtures.js";

const actor = {
  provider: "webhook" as const,
  botId: "webhook-1",
  providerUserId: "user-1",
  chatType: "private" as const,
};

const feishuActor = {
  provider: "feishu" as const,
  botId: "feishu-1",
  providerUserId: "ou_user",
  chatType: "private" as const,
};

const weixinActor = {
  provider: "weixin" as const,
  botId: "weixin-1",
  providerUserId: "wx_user",
  chatType: "private" as const,
};

async function bind(service: ReturnType<typeof f.createBotsService>) {
  const code = await service.createBindCode({ botId: "webhook-1" });
  await service.handleInboundMessage({
    botId: "webhook-1",
    text: `/bind ${code.code}`,
    actor,
  });
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe("botsService messageFlow", () => {
  it.each(["available", "unavailable", "missing"] as const)(
    "绑定后从 Session 原选择解析下一条输入，不读 Bot 默认或创建草稿：%s",
    async (availability) => {
      const original = {
        providerId: "account:personal",
        modelId: "glm",
        options: { reasoningLevel: "high" },
      };
      const effective = { ...original, providerId: "account:team" };
      const repo = f.createMemoryRepo(f.baseConfig);
      const tasks = f.createLegacyTaskService();
      const getView = vi.fn(async () => ({
        providers: [],
        effectiveSelection: availability === "available" ? effective : null,
        preferredSelection: effective,
      }));
      const service = f.createBotsService({
        repo: repo as never,
        legacyTaskService: tasks,
        modelSelectionService: { getView } as never,
      });
      await bind(service);
      const bound = await repo.readState();
      bound.bots[actor.botId] = {
        botId: actor.botId,
        workspacePath: "/tmp/workspace",
        workspaceIdentity: "ssh://host/tmp/workspace",
        updatedAt: Date.now(),
        mode: "task",
        activeTaskId: "task-1",
        draftOptions: undefined,
      };
      await repo.writeState(bound);
      vi.mocked(tasks.getTaskModelSelection).mockResolvedValue(
        availability === "missing" ? null : original,
      );
      vi.mocked(tasks.sendPrompt).mockClear();
      getView.mockClear();
      const submission = service.handleInboundMessage({ botId: actor.botId, actor, text: "next" });
      if (availability === "available") {
        await submission;
        await vi.waitFor(() =>
          expect(tasks.sendPrompt).toHaveBeenCalledWith(
            expect.objectContaining({
              taskId: "task-1",
              content: "next",
              modelSelection: effective,
            }),
          ),
        );
      } else {
        await expect(submission).rejects.toThrow("原选择已保留");
        expect(tasks.sendPrompt).not.toHaveBeenCalled();
        expect(tasks.setModel).not.toHaveBeenCalled();
      }
      expect(tasks.getTaskModelSelection).toHaveBeenCalledWith({ taskId: "task-1" });
      if (availability === "missing") expect(getView).not.toHaveBeenCalled();
      else expect(getView).toHaveBeenCalledWith(expect.objectContaining({ selection: original }));
      const state = await repo.readState();
      expect(state.bots[actor.botId]?.draftOptions).toBeUndefined();
      expect(original.providerId).toBe("account:personal");
      service.disposeAll();
    },
  );
  it("startup reads current storage without re-running legacy migration or writing state", async () => {
    const baseRepo = f.createMemoryRepo(f.feishuConfig);
    const readState = vi.fn(() => baseRepo.readState());
    const writeState = vi.fn((state: BotsStateFile) => baseRepo.writeState(state));
    const service = f.createBotsService({ repo: { ...baseRepo, readState, writeState } as never });
    await vi.waitFor(() => expect(readState).toHaveBeenCalled());
    expect(writeState).not.toHaveBeenCalled();
    service.disposeAll();
  });

  it("activates Weixin on the first message after QR confirmation", async () => {
    const repo = f.createMemoryRepo(f.weixinConfig, {
      version: 3,
      bots: {
        "weixin-1": {
          botId: "weixin-1",
          workspacePath: "/tmp/workspace",
          workspaceIdentity: "ssh://host/tmp/workspace",
          workspaceId: "ssh://host/tmp/workspace",
          mode: "draft",
          activeTaskId: null,
          weixinGetUpdatesBuf: "cursor-only",
          updatedAt: Date.now(),
        },
      },
    });
    const legacyTaskService = f.createLegacyTaskService();
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "weixin-token": "token" }),
      legacyTaskService,
      repo: repo as never,
    });

    const activationReplies = await service.handleInboundMessage({
      botId: "weixin-1",
      text: "你好",
      actor: {
        provider: "weixin",
        botId: "weixin-1",
        providerUserId: "wx_user",
        chatType: "private",
      },
    });

    expect(activationReplies[0]?.text).toContain("微信 Bot 已激活");
    expect(legacyTaskService.createTask).not.toHaveBeenCalled();

    const replies = await service.handleInboundMessage({
      botId: "weixin-1",
      text: "请检查当前项目",
      actor: {
        provider: "weixin",
        botId: "weixin-1",
        providerUserId: "wx_user",
        chatType: "private",
      },
    });

    expect(replies).toEqual([]);
    expect(legacyTaskService.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath: "/tmp/workspace",
        workspaceIdentity: "ssh://host/tmp/workspace",
        provider: "glm",
      }),
    );
    service.disposeAll();
  });

  it("renders Weixin selections as plain numbered text without native selection payload", async () => {
    const repo = f.createMemoryRepo(f.weixinConfig);
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "weixin-token": "token" }),
      legacyTaskService: f.createLegacyTaskService(),
      repo: repo as never,
    });

    const replies = await service.handleInboundMessage({
      botId: "weixin-1",
      text: "/workspace",
      actor: {
        provider: "weixin",
        botId: "weixin-1",
        providerUserId: "wx_user",
        chatType: "private",
      },
    });

    expect(replies[0]).toMatchObject({
      provider: "weixin",
      providerUserId: "wx_user",
    });
    expect(replies[0]).not.toHaveProperty("selection");
    expect(replies[0]?.text).toContain("选择 workspace");
    expect(replies[0]?.text).toContain("1.");
    expect(replies[0]?.text).toContain("[远端]");
    expect(replies[0]?.text).not.toContain("[本地]");
    expect(replies[0]?.text).toContain("0. 取消");
    expect(replies[0]?.text).toContain("回复数字选择，0 取消。");
    expect(replies[0]?.text).not.toContain("/workspace");
    expect(replies[0]?.text).not.toContain("ssh://host/tmp/workspace");
    service.disposeAll();
  });

  it("marks remote workspaces in native selection labels", async () => {
    const repo = f.createMemoryRepo(f.baseConfig);
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "secret-1": "secret" }),
      legacyTaskService: f.createLegacyTaskService(),
      repo: repo as never,
    });

    await bind(service);
    const replies = await service.handleInboundMessage({
      botId: "webhook-1",
      text: "/workspace",
      actor,
    });

    expect(replies[0]?.selection?.options[0]?.label).toContain("[远端]");
    expect(replies[0]?.selection?.options[0]).not.toHaveProperty("description");
    service.disposeAll();
  });

  it("localizes Weixin text selection cancel hints", async () => {
    const repo = f.createMemoryRepo(f.weixinConfig);
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "weixin-token": "token" }),
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

    const replies = await service.handleInboundMessage({
      botId: "weixin-1",
      text: "/workspace",
      actor: weixinActor,
    });

    expect(replies[0]?.text).toContain("0. Cancel");
    expect(replies[0]?.text).toContain("Reply with a number to choose, or 0 to cancel.");
    service.disposeAll();
  });

  it("cancels a Weixin text selection with 0", async () => {
    const repo = f.createMemoryRepo(f.weixinConfig);
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "weixin-token": "token" }),
      legacyTaskService: f.createLegacyTaskService(),
      repo: repo as never,
    });

    await service.handleInboundMessage({
      botId: "weixin-1",
      text: "/workspace",
      actor: weixinActor,
    });
    const replies = await service.handleInboundMessage({
      botId: "weixin-1",
      text: "0",
      actor: weixinActor,
    });

    expect(replies[0]?.text).toContain("工作区:");
    expect(replies[0]?.text).not.toContain("Provider:");
    service.disposeAll();
  });

  it("resolves Weixin workspace/reply selections and allows draft model selection", async () => {
    const repo = f.createMemoryRepo(f.weixinConfig);
    const legacyTaskService = f.createLegacyTaskService();
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "weixin-token": "token" }),
      legacyTaskService,
      modelSelectionService: f.createModelSelectionService([
        {
          id: "runtime-provider",
          name: "Runtime Provider",
          endpoints: { baseURL: "https://example.com/v1", paths: { "openai-compatible": "" } },
          defaultKind: "openai-compatible",
          apiKey: "key",
          models: [
            "gpt-5.3",
            {
              id: "gpt-5.4",
              config: {
                optionSpecs: {
                  reasoningLevel: {
                    values: ["low", "medium", "high"],
                  },
                },
              },
            },
          ],
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
      repo: repo as never,
    });

    await service.handleInboundMessage({
      botId: "weixin-1",
      text: "/workspace",
      actor: weixinActor,
    });
    const workspaceReplies = await service.handleInboundMessage({
      botId: "weixin-1",
      text: "1",
      actor: weixinActor,
    });
    expect(workspaceReplies[0]?.text).toContain("工作区:");
    expect(workspaceReplies[0]?.text).toContain("任务: 草稿");

    const modelReplies = await service.handleInboundMessage({
      botId: "weixin-1",
      text: "/model",
      actor: weixinActor,
    });
    expect(modelReplies[0]?.text).toContain("选择模型供应商");

    const replyList = await service.handleInboundMessage({
      botId: "weixin-1",
      text: "/reply",
      actor: weixinActor,
    });
    expect(replyList[0]?.text).toContain("标准回复");
    expect(replyList[0]?.text).toContain("完整回复");
    expect(replyList[0]?.text).toContain("摘要回复");
    expect(replyList[0]?.text).not.toContain("流式卡片");
    const rejectedStreamingCard = await service.handleInboundMessage({
      botId: "weixin-1",
      text: "/reply streaming_card",
      actor: weixinActor,
    });
    expect(rejectedStreamingCard[0]?.text).toContain("未找到回复颗粒度");

    await service.handleInboundMessage({
      botId: "weixin-1",
      text: "/reply",
      actor: weixinActor,
    });
    const replyReplies = await service.handleInboundMessage({
      botId: "weixin-1",
      text: "2",
      actor: weixinActor,
    });
    expect(replyReplies[0]?.text).toContain("工作区:");
    expect(replyReplies[0]?.text).toContain("任务: 草稿");
    expect((await repo.readConfig()).bots[0]).toMatchObject({
      currentOptions: {},
      replyMode: "assistant_toolcalls_changes",
    });
    service.disposeAll();
  });

  it("limits Feishu reply granularity command to streaming cards", async () => {
    const repo = f.createMemoryRepo({
      ...f.feishuConfig,
      bots: [
        {
          ...f.feishuConfig.bots[0]!,
          replyMode: "assistant_changes",
        },
      ],
    });
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "feishu-secret": "secret" }),
      legacyTaskService: f.createLegacyTaskService(),
      repo: repo as never,
    });

    const listReplies = await service.handleInboundMessage({
      botId: "feishu-1",
      text: "/reply",
      actor: feishuActor,
    });

    expect(listReplies[0]?.selection?.options).toEqual([
      expect.objectContaining({
        id: "streaming_card",
        label: expect.stringContaining("流式卡片"),
      }),
    ]);
    expect(listReplies[0]?.selection?.currentId).toBe("streaming_card");

    const rejectedReplies = await service.handleInboundMessage({
      botId: "feishu-1",
      text: "/reply assistant_changes",
      actor: feishuActor,
    });

    expect(rejectedReplies[0]?.text).toContain("未找到回复颗粒度");
    expect((await repo.readConfig()).bots[0]?.replyMode).toBe("assistant_changes");

    const acceptedReplies = await service.handleInboundMessage({
      botId: "feishu-1",
      text: "/reply 1",
      actor: feishuActor,
    });

    expect(acceptedReplies[0]?.text).toContain("工作区:");
    expect((await repo.readConfig()).bots[0]?.replyMode).toBe("streaming_card");
    service.disposeAll();
  });

  it("keeps the current remote workspace available in /workspace selections", async () => {
    const repo = f.createMemoryRepo(f.weixinConfig, {
      version: 3,
      bots: {
        "weixin-1": {
          botId: "weixin-1",
          workspacePath: "/tmp/workspace",
          workspaceIdentity: "ssh://host/tmp/workspace",
          workspaceId: "ssh://host/tmp/workspace",
          mode: "task",
          activeTaskId: "task-1",
          updatedAt: Date.now(),
        },
      },
    });
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "weixin-token": "token" }),
      legacyTaskService: f.createLegacyTaskService(),
      settingService: f.createSettingService({
        locale: "zh-CN",
        lastWorkspaceSession: [
          {
            kind: "local",
            workspacePath: "/tmp/workspace",
          },
        ],
      }),
      repo: repo as never,
    });

    const listReplies = await service.handleInboundMessage({
      botId: "weixin-1",
      text: "/workspace",
      actor: weixinActor,
    });
    expect(listReplies[0]?.text).toContain("[远端]");

    const switchReplies = await service.handleInboundMessage({
      botId: "weixin-1",
      text: "1",
      actor: weixinActor,
    });

    expect(switchReplies[0]?.text).toContain("工作区:");
    expect(switchReplies[0]?.text).toContain("任务: 草稿");
    expect((await repo.readState()).bots["weixin-1"]).toMatchObject({
      workspacePath: "/tmp/workspace",
      workspaceIdentity: "ssh://host/tmp/workspace",
      workspaceId: "ssh://host/tmp/workspace",
      activeTaskId: null,
      mode: "draft",
    });
    service.disposeAll();
  });

  it("resolves Weixin plain-number pending selections for config and task", async () => {
    const repo = f.createMemoryRepo(f.weixinConfig, {
      version: 3,
      bots: {
        "weixin-1": {
          botId: "weixin-1",
          workspacePath: "/tmp/workspace",
          workspaceIdentity: "ssh://host/tmp/workspace",
          workspaceId: "ssh://host/tmp/workspace",
          mode: "task",
          activeTaskId: "task-1",
          updatedAt: Date.now(),
        },
      },
    });
    const legacyTaskService = f.createLegacyTaskService();
    const configOptions = [
      {
        id: "reasoning_effort",
        category: "thought_level",
        type: "select" as const,
        currentValue: "low",
        options: [{ value: "medium", name: "Medium" }],
      },
      {
        id: "runtime_mode",
        category: "mode",
        type: "select" as const,
        currentValue: "default",
        options: [{ value: "auto", name: "Auto" }],
      },
    ];
    Object.assign(legacyTaskService, {
      getTaskConfigOptions: vi.fn(async () => configOptions),
      listTasks: vi.fn(async () => [
        {
          taskId: "task-1",
          title: "First task",
          status: "completed",
          workspacePath: "/tmp/workspace",
          workspaceIdentity: "ssh://host/tmp/workspace",
          provider: "codex",
        },
        {
          taskId: "task-2",
          title: "Second task",
          status: "completed",
          workspacePath: "/tmp/workspace",
          workspaceIdentity: "ssh://host/tmp/workspace",
          provider: "codex",
        },
      ]),
    });
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "weixin-token": "token" }),
      legacyTaskService,
      repo: repo as never,
    });

    await service.handleInboundMessage({
      botId: "weixin-1",
      text: "/think",
      actor: weixinActor,
    });
    const thoughtReplies = await service.handleInboundMessage({
      botId: "weixin-1",
      text: "1",
      actor: weixinActor,
    });
    expect(thoughtReplies[0]?.text).toContain("工作区:");
    expect(thoughtReplies[0]?.text).toContain("任务:");

    const modeReplies = await service.handleInboundMessage({
      botId: "weixin-1",
      text: "/mode",
      actor: weixinActor,
    });
    expect(modeReplies[0]?.text).toContain("yolo");

    await service.handleInboundMessage({
      botId: "weixin-1",
      text: "/task",
      actor: weixinActor,
    });
    expect(
      (
        await service.handleInboundMessage({
          botId: "weixin-1",
          text: "2",
          actor: weixinActor,
        })
      )[0]?.text,
    ).toContain("工作区:");

    expect((await repo.readConfig()).bots[0]?.currentOptions).toEqual({});
    expect(legacyTaskService.setConfigOption).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-1",
        configId: "reasoning_effort",
        value: "medium",
      }),
    );
    expect(legacyTaskService.setConfigOption).not.toHaveBeenCalledWith(
      expect.objectContaining({ configId: "mode" }),
    );
    expect((await repo.readState()).bots["weixin-1"]).toMatchObject({
      activeTaskId: "task-2",
      mode: "task",
    });
    service.disposeAll();
  });

  it("switches remote task from the displayed /task selection when later listTasks misses it", async () => {
    const repo = f.createMemoryRepo(f.weixinConfig, {
      version: 3,
      bots: {
        "weixin-1": {
          botId: "weixin-1",
          workspacePath: "/tmp/workspace",
          workspaceIdentity: "ssh://host/tmp/workspace",
          workspaceId: "ssh://host/tmp/workspace",
          mode: "task",
          activeTaskId: "task-1",
          updatedAt: Date.now(),
        },
      },
    });
    const legacyTaskService = f.createLegacyTaskService();
    vi.mocked(legacyTaskService.listTasks)
      .mockResolvedValueOnce([
        {
          taskId: "task-1",
          title: "Remote first task",
          status: "completed",
          workspacePath: "/tmp/workspace",
          workspaceIdentity: "ssh://host/tmp/workspace",
          provider: "codex",
        },
        {
          taskId: "task-2",
          title: "Remote second task",
          status: "completed",
          workspacePath: "/tmp/workspace",
          workspaceIdentity: "ssh://host/tmp/workspace",
          provider: "codex",
        },
      ])
      .mockResolvedValue([]);
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "weixin-token": "token" }),
      legacyTaskService,
      repo: repo as never,
    });

    const taskReplies = await service.handleInboundMessage({
      botId: "weixin-1",
      text: "/task",
      actor: weixinActor,
    });
    expect(taskReplies[0]?.text).toContain("Remote second task");

    const switchReplies = await service.handleInboundMessage({
      botId: "weixin-1",
      text: "2",
      actor: weixinActor,
    });

    expect(switchReplies[0]?.text).toContain("工作区:");
    expect((await repo.readState()).bots["weixin-1"]).toMatchObject({
      activeTaskId: "task-2",
      mode: "task",
      workspaceIdentity: "ssh://host/tmp/workspace",
    });
    service.disposeAll();
  });

  it("treats non-number text after a Weixin /task menu as a normal prompt", async () => {
    const repo = f.createMemoryRepo(f.weixinConfig, {
      version: 3,
      bots: {
        "weixin-1": {
          botId: "weixin-1",
          workspacePath: "/tmp/workspace",
          workspaceIdentity: "ssh://host/tmp/workspace",
          workspaceId: "ssh://host/tmp/workspace",
          mode: "task",
          activeTaskId: "task-1",
          updatedAt: Date.now(),
        },
      },
    });
    const legacyTaskService = f.createLegacyTaskService();
    vi.mocked(legacyTaskService.listTasks).mockResolvedValue([
      {
        taskId: "task-1",
        title: "Current task",
        status: "completed",
        workspacePath: "/tmp/workspace",
        workspaceIdentity: "ssh://host/tmp/workspace",
        provider: "codex",
      },
      {
        taskId: "task-2",
        title: "hello",
        status: "completed",
        workspacePath: "/tmp/workspace",
        workspaceIdentity: "ssh://host/tmp/workspace",
        provider: "codex",
      },
    ]);
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "weixin-token": "token" }),
      legacyTaskService,
      repo: repo as never,
    });

    const taskReplies = await service.handleInboundMessage({
      botId: "weixin-1",
      text: "/task",
      actor: weixinActor,
    });
    expect(taskReplies[0]?.text).toContain("hello");

    const promptReplies = await service.handleInboundMessage({
      botId: "weixin-1",
      text: "hello",
      actor: weixinActor,
    });

    expect(promptReplies).toEqual([]);
    expect(legacyTaskService.resumeTask).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task-1" }),
    );
    expect(legacyTaskService.sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task-1", content: "hello" }),
    );
    expect((await repo.readState()).bots["weixin-1"]).toMatchObject({
      activeTaskId: "task-1",
    });
    service.disposeAll();
  });

  it("does not allow implicit pending selection replies outside Weixin", async () => {
    const telegramActor = {
      provider: "telegram" as const,
      botId: "telegram-1",
      providerUserId: "user-1",
      chatType: "private" as const,
    };
    const repo = f.createMemoryRepo(f.telegramConfig, {
      version: 3,
      bots: {
        "telegram-1": {
          botId: "telegram-1",
          workspacePath: "/tmp/workspace",
          workspaceIdentity: "ssh://host/tmp/workspace",
          workspaceId: "ssh://host/tmp/workspace",
          mode: "task",
          activeTaskId: "task-1",
          updatedAt: Date.now(),
        },
      },
    });
    const legacyTaskService = f.createLegacyTaskService();
    vi.mocked(legacyTaskService.listTasks).mockResolvedValue([
      {
        taskId: "task-1",
        title: "Current task",
        status: "completed",
        workspacePath: "/tmp/workspace",
        workspaceIdentity: "ssh://host/tmp/workspace",
        provider: "codex",
      },
      {
        taskId: "task-2",
        title: "Next task",
        status: "completed",
        workspacePath: "/tmp/workspace",
        workspaceIdentity: "ssh://host/tmp/workspace",
        provider: "codex",
      },
    ]);
    const service = f.createBotsService({
      credentialService: f.createCredentialService({
        "telegram-token": "token",
      }),
      legacyTaskService,
      repo: repo as never,
    });

    const taskReplies = await service.handleInboundMessage({
      botId: "telegram-1",
      text: "/task",
      actor: telegramActor,
    });
    expect(taskReplies[0]).toHaveProperty("selection");

    const promptReplies = await service.handleInboundMessage({
      botId: "telegram-1",
      text: "2",
      actor: telegramActor,
    });

    expect(promptReplies).toEqual([]);
    expect(legacyTaskService.resumeTask).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task-1" }),
    );
    expect(legacyTaskService.sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task-1", content: "2" }),
    );
    expect((await repo.readState()).bots["telegram-1"]).toMatchObject({
      activeTaskId: "task-1",
    });
    service.disposeAll();
  });

  it("syncs active task model, mode, and cli changes through ZCode Agent and broadcasts UI updates", async () => {
    const repo = f.createMemoryRepo(f.weixinConfig, {
      version: 3,
      bots: {
        "weixin-1": {
          botId: "weixin-1",
          workspacePath: "/tmp/workspace",
          workspaceIdentity: "ssh://host/tmp/workspace",
          workspaceId: "ssh://host/tmp/workspace",
          mode: "task",
          activeTaskId: "task-1",
          updatedAt: Date.now(),
        },
      },
    });
    const legacyTaskService = f.createLegacyTaskService();
    const configOptions = [
      {
        id: "model",
        category: "model",
        type: "select" as const,
        currentValue: "gpt-5.3",
        options: [
          {
            value: "gpt-5.3",
            name: "GPT-5.3",
            modelProviderId: "glm",
            modelProviderName: "ZCode Agent",
          },
          {
            value: "gpt-5.4",
            name: "GPT-5.4",
            modelProviderId: "glm",
            modelProviderName: "ZCode Agent",
          },
        ],
      },
      {
        id: "mode",
        category: "mode",
        type: "select" as const,
        currentValue: "default",
        options: [{ value: "plan", name: "Plan" }],
      },
    ];
    vi.mocked(legacyTaskService.getTaskConfigOptions).mockResolvedValue(configOptions);
    vi.mocked(legacyTaskService.listTasks).mockResolvedValue([
      {
        taskId: "task-1",
        title: "Active task",
        workspacePath: "/tmp/workspace",
        workspaceIdentity: "ssh://host/tmp/workspace",
        provider: "codex",
        model: "gpt-5.3",
        mode: "default",
        status: "completed",
      },
    ]);
    vi.mocked(legacyTaskService.setModel).mockResolvedValue([
      { ...configOptions[0]!, currentValue: "gpt-5.4" },
      configOptions[1]!,
    ]);
    vi.mocked(legacyTaskService.setConfigOption).mockResolvedValue([
      configOptions[0]!,
      { ...configOptions[1]!, currentValue: "plan" },
    ]);
    const broadcastService = f.createBroadcastService();
    const zcodeSessionService = f.createZCodeSessionService(
      f.createZCodeSessionSettingsFromConfigOptions(configOptions),
    );
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "weixin-token": "token" }),
      legacyTaskService,
      zcodeSessionService,
      broadcastService,
      modelSelectionService: f.createModelSelectionService([
        {
          id: "custom-provider",
          name: "Custom Provider",
          endpoints: {
            baseURL: "https://example.com/v1",
            paths: { "openai-compatible": "" },
          },
          defaultKind: "openai-compatible",
          apiKey: "key",
          models: [
            {
              id: "glm-4.7",
              config: { optionSpecs: { reasoningLevel: { values: ["low", "high", "max"] } } },
            },
          ],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ]),
      repo: repo as never,
    });

    const modelProviderReplies = await service.handleInboundMessage({
      botId: "weixin-1",
      text: "/model",
      actor: weixinActor,
    });
    expect(modelProviderReplies[0]?.text).toContain("Custom Provider");
    expect(modelProviderReplies[0]?.text).not.toContain("GPT-5.3, GPT-5.4");
    expect(modelProviderReplies[0]?.text).not.toContain("glm-4.7");
    await service.handleInboundMessage({
      botId: "weixin-1",
      text: "1",
      actor: weixinActor,
    });
    const modelReplies = await service.handleInboundMessage({
      botId: "weixin-1",
      text: "1",
      actor: weixinActor,
    });
    expect(modelReplies[0]?.text).not.toContain("未找到模型供应商");
    expect(modelReplies[0]?.text).toContain("工作区:");
    const modeReplies = await service.handleInboundMessage({
      botId: "weixin-1",
      text: "/mode",
      actor: weixinActor,
    });
    expect(modeReplies[0]?.text).toContain("yolo");
    expect(legacyTaskService.setModel).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-1",
        modelSelection: {
          providerId: "custom-provider",
          modelId: "glm-4.7",
          options: { reasoningLevel: "max" },
        },
      }),
    );
    expect(legacyTaskService.setConfigOption).not.toHaveBeenCalledWith(
      expect.objectContaining({ configId: "mode" }),
    );
    expect(broadcastService.send).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "bots:task",
        payload: expect.objectContaining({
          taskId: "task-1",
          provider: "glm",
          configOptions: expect.arrayContaining([
            expect.objectContaining({ currentValue: "gpt-5.4" }),
          ]),
        }),
      }),
    );
    expect((await repo.readConfig()).bots[0]?.currentOptions).toEqual({});
    service.disposeAll();
  });

  it("passes only custom provider modelSelection when a remote Bot switches models", async () => {
    const providerId = "custom-provider-b";
    const modelId = "gpt-5.5";
    const repo = f.createMemoryRepo(f.weixinConfig, {
      version: 3,
      bots: {
        "weixin-1": {
          botId: "weixin-1",
          workspacePath: "/tmp/workspace",
          workspaceIdentity: "ssh://host/tmp/workspace",
          workspaceId: "ssh://host/tmp/workspace",
          mode: "task",
          activeTaskId: "task-1",
          updatedAt: Date.now(),
        },
      },
    });
    const legacyTaskService = f.createLegacyTaskService();
    const configOptions = [
      {
        id: "model",
        category: "model",
        type: "select" as const,
        currentValue: "glm-4.6",
        options: [{ value: "glm-4.6", name: "GLM 4.6" }],
      },
    ];
    vi.mocked(legacyTaskService.getTaskConfigOptions).mockResolvedValue(configOptions);
    vi.mocked(legacyTaskService.listTasks).mockResolvedValue([
      {
        taskId: "task-1",
        title: "Active task",
        workspacePath: "/tmp/workspace",
        workspaceIdentity: "ssh://host/tmp/workspace",
        provider: "glm",
        model: "glm-4.6",
        status: "completed",
      },
    ]);
    vi.mocked(legacyTaskService.setModel).mockResolvedValue([
      {
        ...configOptions[0]!,
        currentValue: encodeCustomModelValue(providerId, modelId),
      },
    ]);
    const zcodeSessionService = Object.assign(
      f.createZCodeSessionService(f.createZCodeSessionSettingsFromConfigOptions(configOptions)),
      {
        updateProviderRegistry: vi.fn(async () => undefined),
      },
    );
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "weixin-token": "token" }),
      legacyTaskService,
      zcodeSessionService,
      modelSelectionService: {
        getView: vi.fn(async () => ({
          revision: 1,
          providers: [
            {
              providerId,
              config: {
                kind: "api" as const,
                apiFormat: "openai-chat-completions" as const,
                baseURL: "https://example.com/v1",
                models: [modelId],
              },
              models: [
                {
                  modelId,
                  config: { optionSpecs: { reasoningLevel: { values: ["low", "high", "max"] } } },
                },
              ],
            },
          ],
        })),
      } as never,
      repo: repo as never,
    });

    const providerReplies = await service.handleInboundMessage({
      botId: "weixin-1",
      text: `/model provider ${providerId}`,
      actor: weixinActor,
    });
    expect(providerReplies[0]?.text).toContain("选择模型");
    await service.handleInboundMessage({
      botId: "weixin-1",
      text: "1",
      actor: weixinActor,
    });

    expect(zcodeSessionService.updateProviderRegistry).not.toHaveBeenCalled();
    expect(legacyTaskService.setModel).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-1",
        modelSelection: { providerId, modelId, options: { reasoningLevel: "max" } },
      }),
    );
    service.disposeAll();
  });

  it("does not push the legacy provider snapshot when a local Bot switches models", async () => {
    const providerId = "local-registry-provider";
    const modelId = "gpt-5.6";
    const repo = f.createMemoryRepo(f.weixinConfig, {
      version: 3,
      bots: {
        "weixin-1": {
          botId: "weixin-1",
          workspacePath: "/tmp/workspace",
          workspaceId: "/tmp/workspace",
          mode: "task",
          activeTaskId: "task-1",
          updatedAt: Date.now(),
        },
      },
    });
    const zcodeTaskService = f.createLegacyTaskService();
    const configOptions = [
      {
        id: "model",
        category: "model",
        type: "select" as const,
        currentValue: "glm-4.6",
        options: [{ value: "glm-4.6", name: "GLM 4.6" }],
      },
    ];
    vi.mocked(zcodeTaskService.getTaskConfigOptions).mockResolvedValue(configOptions);
    vi.mocked(zcodeTaskService.listTasks).mockResolvedValue([
      {
        taskId: "task-1",
        title: "Active task",
        workspacePath: "/tmp/workspace",
        provider: "glm",
        model: "glm-4.6",
        status: "completed",
      },
    ]);
    vi.mocked(zcodeTaskService.setModel).mockResolvedValue(configOptions);
    const zcodeSessionService = f.createZCodeSessionService();
    const updateProviderRegistry = vi.mocked(zcodeSessionService.updateProviderRegistry);
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "weixin-token": "token" }),
      zcodeTaskService,
      zcodeSessionService,
      settingService: f.createSettingService({
        locale: "zh-CN",
        lastWorkspaceSession: [{ kind: "local", workspacePath: "/tmp/workspace" }],
      }),
      modelSelectionService: {
        getView: vi.fn(async () => ({
          revision: 9,
          providers: [
            {
              providerId,
              providerName: "Local Registry Provider",
              config: {
                api: { type: "openai-chat-completions", baseUrl: "https://example.com/v1" },
              },
              models: [
                {
                  modelId,
                  config: { optionSpecs: { reasoningLevel: { values: ["low", "high", "max"] } } },
                },
              ],
            },
          ],
        })),
      } as never,
      remoteWorkspaceService: undefined,
      repo: repo as never,
    });

    const providerReplies = await service.handleInboundMessage({
      botId: "weixin-1",
      text: `/model provider ${providerId}`,
      actor: weixinActor,
    });
    expect(providerReplies[0]?.text).toContain("选择模型");
    const modelReplies = await service.handleInboundMessage({
      botId: "weixin-1",
      text: "1",
      actor: weixinActor,
    });
    expect(modelReplies[0]?.text).toContain("工作区:");

    expect(zcodeTaskService.setModel).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-1",
        modelSelection: { providerId, modelId, options: { reasoningLevel: "max" } },
      }),
    );
    expect(updateProviderRegistry).not.toHaveBeenCalled();
    service.disposeAll();
  });

  it("renders /mode labels after normalizing legacy task provider to ZCode Agent", async () => {
    const repo = f.createMemoryRepo(f.weixinConfig, {
      version: 3,
      bots: {
        "weixin-1": {
          botId: "weixin-1",
          workspacePath: "/tmp/workspace",
          workspaceIdentity: "ssh://host/tmp/workspace",
          workspaceId: "ssh://host/tmp/workspace",
          mode: "task",
          activeTaskId: "task-1",
          updatedAt: Date.now(),
        },
      },
    });
    const legacyTaskService = f.createLegacyTaskService();
    const configOptions = [
      {
        id: "mode",
        category: "mode",
        type: "select" as const,
        currentValue: "agent",
        options: [
          { value: "read-only", name: "Read Only" },
          { value: "auto", name: "Default" },
          { value: "agent", name: "Agent" },
          { value: "full-access", name: "Full Access" },
          { value: "agent-full-access", name: "Agent (full access)" },
        ],
      },
    ];
    vi.mocked(legacyTaskService.getTaskConfigOptions).mockResolvedValue(configOptions);
    vi.mocked(legacyTaskService.listTasks).mockResolvedValue([
      {
        taskId: "task-1",
        title: "Active task",
        workspacePath: "/tmp/workspace",
        workspaceIdentity: "ssh://host/tmp/workspace",
        provider: "codex",
        status: "completed",
      },
    ]);
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "weixin-token": "token" }),
      legacyTaskService,
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

    const replies = await service.handleInboundMessage({
      botId: "weixin-1",
      text: "/mode",
      actor: weixinActor,
    });

    expect(replies[0]?.text).toContain("yolo");
    service.disposeAll();
  });

  it("loads /mode options from ZCode workspace state when active task has no mode option", async () => {
    const repo = f.createMemoryRepo(f.weixinConfig, {
      version: 3,
      bots: {
        "weixin-1": {
          botId: "weixin-1",
          workspacePath: "/tmp/workspace",
          workspaceIdentity: "ssh://host/tmp/workspace",
          workspaceId: "ssh://host/tmp/workspace",
          mode: "task",
          activeTaskId: "task-1",
          updatedAt: Date.now(),
        },
      },
    });
    const legacyTaskService = f.createLegacyTaskService();
    vi.mocked(legacyTaskService.getTaskConfigOptions).mockResolvedValue([]);
    vi.mocked(legacyTaskService.listTasks).mockResolvedValue([
      {
        taskId: "task-1",
        title: "Active task",
        workspacePath: "/tmp/workspace",
        workspaceIdentity: "ssh://host/tmp/workspace",
        provider: "codex",
        mode: "auto",
        status: "completed",
      },
    ]);
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "weixin-token": "token" }),
      legacyTaskService,
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

    const replies = await service.handleInboundMessage({
      botId: "weixin-1",
      text: "/mode",
      actor: weixinActor,
    });

    expect(replies[0]?.text).toContain("yolo");
    expect(legacyTaskService.setConfigOption).not.toHaveBeenCalledWith(
      expect.objectContaining({ configId: "mode" }),
    );
    service.disposeAll();
  });

  it("keeps /think options tied to active task config", async () => {
    const repo = f.createMemoryRepo(f.weixinConfig, {
      version: 3,
      bots: {
        "weixin-1": {
          botId: "weixin-1",
          workspacePath: "/tmp/workspace",
          workspaceIdentity: "ssh://host/tmp/workspace",
          workspaceId: "ssh://host/tmp/workspace",
          mode: "task",
          activeTaskId: "task-1",
          updatedAt: Date.now(),
        },
      },
    });
    const legacyTaskService = f.createLegacyTaskService();
    vi.mocked(legacyTaskService.getTaskConfigOptions).mockResolvedValue([]);
    vi.mocked(legacyTaskService.listTasks).mockResolvedValue([
      {
        taskId: "task-1",
        title: "Active task",
        workspacePath: "/tmp/workspace",
        workspaceIdentity: "ssh://host/tmp/workspace",
        provider: "codex",
        status: "completed",
      },
    ]);
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "weixin-token": "token" }),
      legacyTaskService,
      repo: repo as never,
    });

    const replies = await service.handleInboundMessage({
      botId: "weixin-1",
      text: "/think",
      actor: weixinActor,
    });

    expect(replies[0]?.text).toContain("当前模型不支持思考级别");
    expect(replies[0]?.text).not.toContain("Medium");
    service.disposeAll();
  });

  it("loads local Bot model providers from Model Selection Service", async () => {
    const repo = f.createMemoryRepo(f.weixinConfig, {
      version: 3,
      bots: {
        "weixin-1": {
          botId: "weixin-1",
          workspacePath: "/tmp/workspace",
          workspaceIdentity: "ssh://host/tmp/workspace",
          workspaceId: "ssh://host/tmp/workspace",
          mode: "task",
          activeTaskId: "task-1",
          updatedAt: Date.now(),
        },
      },
    });
    const legacyTaskService = f.createLegacyTaskService();
    vi.mocked(legacyTaskService.getTaskConfigOptions).mockResolvedValue([
      {
        id: "model",
        category: "model",
        type: "select" as const,
        currentValue: "gpt-5.3",
        options: [],
      },
    ]);
    vi.mocked(legacyTaskService.listTasks).mockResolvedValue([
      {
        taskId: "task-1",
        title: "Active task",
        workspacePath: "/tmp/workspace",
        workspaceIdentity: "ssh://host/tmp/workspace",
        provider: "glm",
        model: "gpt-5.3",
        status: "completed",
      },
    ]);
    const zcodeSessionService = f.createZCodeSessionService(
      f.createZCodeSessionSettingsFromConfigOptions([
        {
          id: "model",
          category: "model",
          type: "select" as const,
          currentValue: "gpt-5.3",
          options: [
            {
              value: "gpt-5.4",
              name: "GPT-5.4",
              modelProviderId: "glm",
              modelProviderName: "ZCode Agent",
            },
          ],
        },
      ]),
    );
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "weixin-token": "token" }),
      legacyTaskService,
      zcodeSessionService,
      modelSelectionService: {
        getView: vi.fn(async () => ({
          revision: 7,
          providers: [
            {
              providerId: "runtime-provider",
              providerName: "Runtime Provider",
              config: {
                api: { type: "openai-chat-completions", baseUrl: "https://example.com/v1" },
              },
              models: [
                {
                  modelId: "gpt-5.4",
                  config: { optionSpecs: { reasoningLevel: { values: ["low", "high", "max"] } } },
                },
              ],
            },
          ],
        })),
      } as never,
      repo: repo as never,
    });
    const replies = await service.handleInboundMessage({
      botId: "weixin-1",
      text: "/model",
      actor: weixinActor,
    });

    expect(replies[0]?.text).toContain("Runtime Provider");
    expect(replies[0]?.text).toContain("当前模型 gpt-5.3");
    await service.handleInboundMessage({
      botId: "weixin-1",
      text: "1",
      actor: weixinActor,
    });
    const modelReplies = await service.handleInboundMessage({
      botId: "weixin-1",
      text: "1",
      actor: weixinActor,
    });
    expect(modelReplies[0]?.text).toContain("工作区:");
    expect(legacyTaskService.setModel).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-1",
        modelSelection: {
          providerId: "runtime-provider",
          modelId: "gpt-5.4",
          options: { reasoningLevel: "max" },
        },
      }),
    );
    service.disposeAll();
  });

  it("formats local Bot status labels from Model Selection Service", async () => {
    const providerId = "runtime-provider";
    const modelId = "gpt-5.4";
    const repo = f.createMemoryRepo(f.weixinConfig, {
      version: 3,
      bots: {
        "weixin-1": {
          botId: "weixin-1",
          workspacePath: "/tmp/workspace",
          workspaceIdentity: "/tmp/workspace",
          workspaceId: "/tmp/workspace",
          mode: "draft",
          activeTaskId: null,
          draftOptions: {
            provider: "glm",
            modelSelection: { providerId, modelId },
          },
          updatedAt: Date.now(),
        },
      },
    });
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "weixin-token": "token" }),
      legacyTaskService: f.createLegacyTaskService(),
      modelSelectionService: {
        getView: vi.fn(async () => ({
          revision: 8,
          effectiveSelection: { providerId, modelId },
          providers: [
            {
              providerId,
              providerName: "Registry Label",
              config: {
                api: {
                  type: "openai-chat-completions",
                  baseUrl: "https://registry.example.com/v1",
                },
              },
              models: [{ modelId, config: {} }],
            },
          ],
        })),
      } as never,
      repo: repo as never,
    });
    const replies = await service.handleInboundMessage({
      botId: "weixin-1",
      text: "/status",
      actor: weixinActor,
    });

    expect(replies[0]?.text).toContain(`模型: Registry Label/${modelId}`);
    service.disposeAll();
  });

  it("ignores persisted legacy Provider cache and uses Model Selection View", async () => {
    const workspacePath = "/tmp/workspace";
    const workspaceIdentity = "ssh://host/tmp/workspace";
    const repo = f.createMemoryRepo(f.weixinConfig, {
      version: 3,
      bots: {
        "weixin-1": {
          botId: "weixin-1",
          workspacePath,
          workspaceIdentity,
          workspaceId: workspaceIdentity,
          mode: "task",
          activeTaskId: "task-1",
          updatedAt: Date.now(),
        },
      },
    });
    const legacyTaskService = f.createLegacyTaskService();
    vi.mocked(legacyTaskService.listTasks).mockResolvedValue([
      {
        taskId: "task-1",
        title: "Active task",
        workspacePath,
        workspaceIdentity,
        provider: "codex",
        model: "cached-native",
        status: "completed",
      },
    ]);
    vi.mocked(legacyTaskService.getTaskConfigOptions).mockResolvedValue([
      {
        id: "model",
        category: "model",
        type: "select" as const,
        currentValue: "cached-native",
        options: [],
      },
    ]);
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "weixin-token": "token" }),
      legacyTaskService,
      modelSelectionService: f.createModelSelectionService([
        {
          id: "cached-custom",
          name: "Cached Provider",
          endpoints: {
            baseURL: "https://example.com/v1",
            paths: { "openai-compatible": "" },
          },
          defaultKind: "openai-compatible",
          apiKey: "real-key",
          models: ["cached-custom-model"],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ]),
      repo: repo as never,
    });

    const providerReplies = await service.handleInboundMessage({
      botId: "weixin-1",
      text: "/model",
      actor: weixinActor,
    });
    expect(providerReplies[0]?.text).not.toContain("Cached Native");
    expect(providerReplies[0]?.text).not.toContain("cached-custom-model");
    expect(providerReplies[0]?.text).toContain("Cached Provider");

    const modelReplies = await service.handleInboundMessage({
      botId: "weixin-1",
      text: "1",
      actor: weixinActor,
    });
    expect(modelReplies[0]?.text).toContain("cached-custom-model");
    service.disposeAll();
  });

  it("does not resolve Feishu model provider clicks from the persisted model cache", async () => {
    const workspacePath = "/tmp/workspace";
    const workspaceIdentity = "ssh://host/tmp/workspace";
    const providerId = "693f9c23-72a5-4f1f-bf4a-4b958add6472";
    const modelId = "deepseek-v4-flash";
    const repo = f.createMemoryRepo(f.feishuConfig, {
      version: 3,
      bots: {
        "feishu-1": {
          botId: "feishu-1",
          workspacePath,
          workspaceIdentity,
          workspaceId: workspaceIdentity,
          mode: "draft",
          activeTaskId: null,
          draftOptions: {
            provider: "glm",
            model: encodeCustomModelValue(providerId, modelId),
          },
          updatedAt: Date.now(),
        },
      },
    });
    const service = f.createBotsService({
      credentialService: f.createCredentialService({
        "feishu-secret": "secret",
      }),
      repo: repo as never,
    });

    const replies = await service.handleInboundMessage({
      botId: "feishu-1",
      text: `/model provider ${providerId}`,
      actor: feishuActor,
    });

    expect(replies[0]?.text).toContain("未找到模型供应商");
    expect(replies[0]?.selection).toBeUndefined();
    service.disposeAll();
  });

  it("uses the same compact selection text for Feishu and Telegram native buttons", async () => {
    const repo = f.createMemoryRepo(f.feishuConfig);
    const service = f.createBotsService({
      legacyTaskService: f.createLegacyTaskService(),
      credentialService: f.createCredentialService({
        "feishu-secret": "secret",
      }),
      repo: repo as never,
    });

    const replies = await service.handleInboundMessage({
      botId: "feishu-1",
      text: "/workspace",
      actor: feishuActor,
    });

    expect(replies[0]).toMatchObject({
      provider: "feishu",
      providerUserId: "ou_user",
      selection: expect.objectContaining({ action: "workspace.set" }),
    });
    expect(replies[0]?.text).toContain("选择 workspace");
    expect(replies[0]?.text).not.toContain("/workspace");
    service.disposeAll();
  });

  it("creates an ZCode Agent task from a bound private message", async () => {
    const repo = f.createMemoryRepo(f.baseConfig);
    const legacyTaskService = f.createLegacyTaskService();
    const broadcastService = f.createBroadcastService();
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "secret-1": "secret" }),
      legacyTaskService,
      broadcastService,
      repo: repo as never,
    });
    await bind(service);

    const replies = await service.handleInboundMessage({
      botId: "webhook-1",
      text: "请检查当前项目",
      actor,
    });

    expect(replies).toEqual([]);
    expect(legacyTaskService.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath: "/tmp/workspace",
        workspaceIdentity: "ssh://host/tmp/workspace",
        provider: "glm",
        modelSelection: { providerId: "glm", modelId: "default" },
        v4Create: true,
      }),
    );
    expect(legacyTaskService.sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ content: "请检查当前项目" }),
    );
    expect((await repo.readState()).bots["webhook-1"]).toMatchObject({
      activeTaskId: "task-1",
      mode: "task",
      workspaceIdentity: "ssh://host/tmp/workspace",
    });
    expect(broadcastService.send).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "bots:task",
        payload: expect.objectContaining({
          event: "created",
          taskId: "task-1",
        }),
      }),
    );
    service.disposeAll();
  });

  it("resolves an unfixed Bot draft from the target Host only when the message forms a Submission", async () => {
    const repo = f.createMemoryRepo(f.baseConfig);
    const legacyTaskService = f.createLegacyTaskService();
    const remoteModelSelectionService = f.createModelSelectionService([
      { id: "remote-provider", name: "Remote", models: ["model-a"] },
    ]);
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "secret-1": "secret" }),
      legacyTaskService,
      remoteWorkspaceService: {
        isConnected: vi.fn(async () => true),
        ensureConnected: vi.fn(async () => ({ ok: true })),
        getZCodeTaskService: vi.fn(async () => legacyTaskService),
        getModelSelectionService: vi.fn(async () => remoteModelSelectionService),
      },
      repo: repo as never,
    });
    await bind(service);
    vi.mocked(remoteModelSelectionService.getView).mockResolvedValue({
      revision: 2,
      providers: [
        {
          providerId: "remote-provider",
          providerName: "Remote",
          config: {},
          models: [{ modelId: "model-b", config: {} }],
        },
      ],
      preferredSelection: { providerId: "remote-provider", modelId: "model-b" },
    });

    await service.handleInboundMessage({
      botId: "webhook-1",
      text: "use the submission-time model",
      actor,
    });

    expect(legacyTaskService.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        modelSelection: { providerId: "remote-provider", modelId: "model-b" },
      }),
    );
    service.disposeAll();
  });

  it("injects a Feishu delivery target into the prompt that may call CronCreate", async () => {
    const repo = f.createMemoryRepo(f.feishuConfig);
    const legacyTaskService = f.createLegacyTaskService();
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "feishu-secret": "secret" }),
      legacyTaskService,
      repo: repo as never,
    });

    await service.handleInboundMessage({
      botId: "feishu-1",
      text: "每天九点生成日报",
      actor: feishuActor,
    });

    expect(legacyTaskService.sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        botDeliveryTarget: {
          provider: "feishu",
          botId: "feishu-1",
          providerUserId: "ou_user",
          chatType: "private",
        },
      }),
    );
    service.disposeAll();
  });

  it("delivers an automation terminal result through the original Weixin bot channel", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ret: 0 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const streamListeners: Array<(event: ZCodeStreamEvent) => Promise<void> | void> = [];
    const legacyTaskService = {
      ...f.createLegacyTaskService(),
      onDynamicTaskEvent: vi.fn(
        () => (listener: (event: ZCodeStreamEvent) => Promise<void> | void) => {
          streamListeners.push(listener);
          return { dispose() {} };
        },
      ),
    };
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "weixin-token": "token" }),
      legacyTaskService,
      repo: f.createMemoryRepo(f.weixinConfig) as never,
    });

    await service.watchAutomationRun({
      target: {
        provider: "weixin",
        botId: "weixin-1",
        providerUserId: "wx_chat_1",
        chatType: "private",
      },
      taskId: "task-automation-1",
      workspacePath: "/tmp/workspace",
      workspaceIdentity: "ssh://host/tmp/workspace",
    });
    expect(legacyTaskService.onDynamicTaskEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-automation-1",
        deliveryKind: "bot-channel-continuous",
      }),
    );
    await streamListeners[0]?.({
      type: "agent_message_chunk",
      taskId: "task-automation-1",
      traceId: "automation-run-1",
      content: "日报已生成。",
    });
    await streamListeners[0]?.({
      type: "task_complete",
      taskId: "task-automation-1",
      traceId: "automation-run-1",
      stopReason: "end_turn",
    });

    const sendCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/ilink/bot/sendmessage"),
    );
    expect(sendCall).toBeDefined();
    expect(String(sendCall?.[1]?.body)).toContain("日报已生成");
    service.disposeAll();
  });

  it.each([
    {
      name: "missing bot",
      config: { ...f.feishuConfig, bots: [] },
      target: { ...feishuActor, botId: "missing-bot" },
    },
    {
      name: "disabled bot",
      config: {
        ...f.feishuConfig,
        bots: f.feishuConfig.bots.map((bot) => ({ ...bot, enabled: false })),
      },
      target: feishuActor,
    },
    {
      name: "provider mismatch",
      config: f.feishuConfig,
      target: { ...feishuActor, provider: "weixin" as const },
    },
  ])(
    "skips automation delivery without opening a task watcher for $name",
    async ({ config, target }) => {
      const legacyTaskService = {
        ...f.createLegacyTaskService(),
        onDynamicTaskEvent: vi.fn(),
      };
      const service = f.createBotsService({
        legacyTaskService,
        repo: f.createMemoryRepo(config) as never,
      });

      // Bot 配置可能在任务创建后被删除、禁用或改成其他 provider；这些变化只跳过回推，
      // 不能建立无效监听，更不能让 scheduler 的桌面执行失败。
      await expect(
        service.watchAutomationRun({
          target,
          taskId: "task-automation-skipped",
          workspacePath: "/tmp/workspace",
        }),
      ).resolves.toBeUndefined();
      expect(legacyTaskService.onDynamicTaskEvent).not.toHaveBeenCalled();
      service.disposeAll();
    },
  );

  it("sends channel replies from workspace task mirror batches", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const repo = f.createMemoryRepo({
      ...f.baseConfig,
      bots: [
        {
          ...f.baseConfig.bots[0]!,
          webhookUrl: "https://example.test/zcode-bot-outbound",
        },
      ],
    });
    const streamListeners: Array<(event: ZCodeStreamEvent) => Promise<void> | void> = [];
    const legacyTaskService = {
      ...f.createLegacyTaskService(),
      onDynamicTaskEvent: vi.fn(
        () => (listener: (event: ZCodeStreamEvent) => Promise<void> | void) => {
          streamListeners.push(listener);
          return { dispose() {} };
        },
      ),
    };
    const broadcastService = f.createBroadcastService();
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "secret-1": "secret" }),
      legacyTaskService,
      broadcastService,
      repo: repo as never,
    });
    await bind(service);

    await service.handleInboundMessage({
      botId: "webhook-1",
      text: "请检查当前项目",
      actor,
    });
    expect(legacyTaskService.onDynamicTaskEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath: "/tmp/workspace",
        workspaceIdentity: "ssh://host/tmp/workspace",
        taskId: "task-1",
        deliveryKind: "bot-channel-continuous",
      }),
    );
    await streamListeners[0]?.({
      type: "task_stream_mirror_batch",
      workspacePath: "/tmp/workspace",
      workspaceIdentity: "ssh://host/tmp/workspace",
      workspaceKey: "ssh://host/tmp/workspace",
      taskId: "task-1",
      traceId: "trace-1",
      runId: "run-1",
      batchSeq: 1,
      fromSeq: 1,
      toSeq: 2,
      terminal: true,
      ops: [
        {
          seq: 1,
          kind: "stream_event",
          event: {
            type: "agent_message_chunk",
            taskId: "task-1",
            traceId: "trace-1",
            content: "完成了。",
          },
        },
        {
          seq: 2,
          kind: "stream_event",
          event: {
            type: "task_complete",
            taskId: "task-1",
            traceId: "trace-1",
            stopReason: "end_turn",
          },
        },
      ],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.test/zcode-bot-outbound",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("完成了。"),
      }),
    );
    service.disposeAll();
  });

  it("streams Feishu replies into one schema 2 timeline card with collapsed tool summaries", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token" }));
      }
      if (String(url).includes("/open-apis/im/v1/messages?receive_id_type=open_id")) {
        return new Response(JSON.stringify({ code: 0, data: { message_id: "om_streaming" } }));
      }
      return new Response(JSON.stringify({ code: 0 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const repo = f.createMemoryRepo({
      ...f.feishuConfig,
      bots: [
        {
          ...f.feishuConfig.bots[0]!,
          replyMode: "streaming_card",
        },
      ],
    });
    const streamListeners: Array<(event: ZCodeStreamEvent) => Promise<void> | void> = [];
    const legacyTaskService = {
      ...f.createLegacyTaskService(),
      onDynamicTaskEvent: vi.fn(
        () => (listener: (event: ZCodeStreamEvent) => Promise<void> | void) => {
          streamListeners.push(listener);
          return { dispose() {} };
        },
      ),
    };
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "feishu-secret": "secret" }),
      legacyTaskService,
      repo: repo as never,
    });

    await service.handleInboundMessage({
      botId: "feishu-1",
      text: "请检查当前项目",
      actor: feishuActor,
    });
    await streamListeners[0]?.({
      type: "agent_message_chunk",
      taskId: "task-1",
      traceId: "trace-1",
      content: "我先检查项目。",
    });
    await streamListeners[0]?.({
      type: "tool_call",
      taskId: "task-1",
      traceId: "trace-1",
      toolId: "tool-1",
      title: "Read README.md",
      kind: "read",
      input: { path: "/tmp/workspace/README.md" },
      raw: {},
    });
    await streamListeners[0]?.({
      type: "tool_call_update",
      taskId: "task-1",
      traceId: "trace-1",
      toolId: "tool-1",
      status: "completed",
      title: "Read README.md",
      kind: "read",
      content: "ok",
      raw: {},
    });
    await streamListeners[0]?.({
      type: "agent_message_chunk",
      taskId: "task-1",
      traceId: "trace-1",
      content: "README 看完了，我再跑测试。",
    });
    await streamListeners[0]?.({
      type: "tool_call",
      taskId: "task-1",
      traceId: "trace-1",
      toolId: "tool-2",
      title: "pnpm test",
      kind: "exec",
      input: { command: "pnpm test" },
      raw: {},
    });
    await streamListeners[0]?.({
      type: "tool_call_update",
      taskId: "task-1",
      traceId: "trace-1",
      toolId: "tool-2",
      status: "completed",
      title: "pnpm test",
      kind: "exec",
      content: "ok",
      raw: {},
    });
    await streamListeners[0]?.({
      type: "agent_message_chunk",
      taskId: "task-1",
      traceId: "trace-1",
      content: "测试完成。",
    });
    await streamListeners[0]?.({
      type: "task_complete",
      taskId: "task-1",
      traceId: "trace-1",
      stopReason: "end_turn",
    });

    const messagePosts = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("/open-apis/im/v1/messages?receive_id_type=open_id"),
    );
    const messagePatches = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("/open-apis/im/v1/messages/om_streaming"),
    );
    expect(messagePosts).toHaveLength(1);
    expect(messagePatches.length).toBeGreaterThanOrEqual(2);
    const runningToolPatch = messagePatches.find(([, init]) =>
      String(init?.body).includes("工具摘要"),
    );
    const runningBody = JSON.parse(String(runningToolPatch?.[1]?.body)) as { content?: string };
    const runningCard = JSON.parse(String(runningBody.content)) as Record<string, unknown>;
    expect(runningCard).toMatchObject({
      schema: "2.0",
      body: {
        elements: expect.arrayContaining([
          expect.objectContaining({
            tag: "collapsible_panel",
            expanded: true,
            background_color: "grey-50",
            border: { color: "grey", corner_radius: "8px" },
            header: expect.objectContaining({
              vertical_align: "center",
              icon: expect.objectContaining({
                tag: "standard_icon",
              }),
              icon_position: "right",
              icon_expanded_angle: -180,
            }),
          }),
        ]),
      },
    });
    const finalPatch = messagePatches.at(-1);
    const body = JSON.parse(String(finalPatch?.[1]?.body)) as { content?: string };
    const card = JSON.parse(String(body.content)) as Record<string, unknown>;
    expect(card).toMatchObject({
      schema: "2.0",
      body: {
        elements: expect.arrayContaining([
          expect.objectContaining({
            tag: "collapsible_panel",
            expanded: false,
            background_color: "grey-50",
            border: { color: "grey", corner_radius: "8px" },
            header: expect.objectContaining({
              vertical_align: "center",
              icon: expect.objectContaining({
                tag: "standard_icon",
              }),
              icon_position: "right",
              icon_expanded_angle: -180,
            }),
          }),
          expect.objectContaining({ tag: "markdown", content: "✅ 已完成" }),
        ]),
      },
    });
    expect(JSON.stringify(card)).toContain("我先检查项目。");
    const elements = (card.body as { elements?: Array<Record<string, unknown>> }).elements ?? [];
    const timeline = elements.map((element) =>
      element.tag === "collapsible_panel"
        ? `tools:${String((element.header as { title?: { content?: string } }).title?.content)}:${String(element.expanded)}`
        : `message:${String(element.content)}`,
    );
    expect(timeline).toEqual([
      "message:我先检查项目。",
      "tools:🛠️ 工具摘要 (1):false",
      "message:README 看完了，我再跑测试。",
      "tools:🛠️ 工具摘要 (1):false",
      "message:测试完成。",
      "message:✅ 已完成",
    ]);
    expect(JSON.stringify(card)).toContain("✅ 已完成");
    service.disposeAll();
  });

  it("backs off failed Feishu card writes and keeps the circuit open for late events", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const fetchMock = vi.fn(async (url: string) => {
        if (url.endsWith("/tenant_access_token/internal")) {
          return new Response(
            JSON.stringify({
              code: 0,
              tenant_access_token: "tenant-token",
            }),
          );
        }
        return new Response(
          JSON.stringify({
            code: 230020,
            msg: "Bot has NO availability to this user.",
          }),
          { status: 400 },
        );
      });
      vi.stubGlobal("fetch", fetchMock);
      const streamListeners: Array<(event: ZCodeStreamEvent) => Promise<void> | void> = [];
      const service = f.createBotsService({
        credentialService: f.createCredentialService({ "feishu-secret": "secret" }),
        legacyTaskService: {
          ...f.createLegacyTaskService(),
          onDynamicTaskEvent: vi.fn(
            () => (listener: (event: ZCodeStreamEvent) => Promise<void> | void) => {
              streamListeners.push(listener);
              return { dispose() {} };
            },
          ),
        },
        repo: f.createMemoryRepo({
          ...f.feishuConfig,
          bots: [{ ...f.feishuConfig.bots[0]!, replyMode: "streaming_card" }],
        }) as never,
      });

      await service.handleInboundMessage({
        botId: "feishu-1",
        text: "请检查当前项目",
        actor: feishuActor,
      });
      const emitChunk = async (content: string) =>
        streamListeners[0]?.({
          type: "agent_message_chunk",
          taskId: "task-1",
          traceId: "trace-1",
          content,
        });
      await emitChunk("第一次");
      vi.setSystemTime(1_000);
      await emitChunk("第二次");
      vi.setSystemTime(3_000);
      await emitChunk("第三次");
      vi.setSystemTime(20 * 60_000 + 3_000);
      await emitChunk("停止二十分钟后的迟到事件");

      const cardWrites = fetchMock.mock.calls.filter(([url]) =>
        String(url).includes("/open-apis/im/v1/messages"),
      );
      expect(cardWrites).toHaveLength(3);
      const runtime = (await service.getStatus()).botRuntime.find(
        (entry) => entry.botId === "feishu-1",
      );
      expect(runtime?.deliveryError).toContain("code=230020");
      expect(runtime?.status).not.toBe("error");
      service.disposeAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry an uncertain Feishu creation without a message id", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      let messagePostCount = 0;
      const fetchMock = vi.fn(async (url: string) => {
        if (url.endsWith("/tenant_access_token/internal")) {
          return new Response(
            JSON.stringify({
              code: 0,
              tenant_access_token: "tenant-token",
            }),
          );
        }
        if (url.includes("/open-apis/im/v1/messages?receive_id_type=open_id")) {
          messagePostCount += 1;
          return new Response(
            JSON.stringify({
              code: 0,
              data: messagePostCount === 1 ? {} : { message_id: "om_streaming_retry" },
            }),
          );
        }
        return new Response(JSON.stringify({ code: 0 }));
      });
      vi.stubGlobal("fetch", fetchMock);
      const streamListeners: Array<(event: ZCodeStreamEvent) => Promise<void> | void> = [];
      const service = f.createBotsService({
        credentialService: f.createCredentialService({ "feishu-secret": "secret" }),
        legacyTaskService: {
          ...f.createLegacyTaskService(),
          onDynamicTaskEvent: vi.fn(
            () => (listener: (event: ZCodeStreamEvent) => Promise<void> | void) => {
              streamListeners.push(listener);
              return { dispose() {} };
            },
          ),
        },
        repo: f.createMemoryRepo({
          ...f.feishuConfig,
          bots: [{ ...f.feishuConfig.bots[0]!, replyMode: "streaming_card" }],
        }) as never,
      });

      await service.handleInboundMessage({
        botId: "feishu-1",
        text: "请检查当前项目",
        actor: feishuActor,
      });
      const emitChunk = async (content: string) =>
        streamListeners[0]?.({
          type: "agent_message_chunk",
          taskId: "task-1",
          traceId: "trace-no-message-id",
          content,
        });
      await emitChunk("第一次");
      vi.setSystemTime(500);
      await emitChunk("退避期间不应重试");
      expect(messagePostCount).toBe(1);

      vi.setSystemTime(1_000);
      await emitChunk("结果未知时不应自动重试");
      expect(messagePostCount).toBe(1);
      service.disposeAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it("seals a full Feishu streaming card and continues the timeline in a new card", async () => {
    let messageId = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/tenant_access_token/internal")) {
        return new Response(
          JSON.stringify({
            code: 0,
            tenant_access_token: "tenant-token",
          }),
        );
      }
      if (url.includes("/open-apis/im/v1/messages?receive_id_type=open_id")) {
        messageId += 1;
        return new Response(
          JSON.stringify({
            code: 0,
            data: { message_id: `om_streaming_${messageId}` },
          }),
        );
      }
      return new Response(JSON.stringify({ code: 0 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const streamListeners: Array<(event: ZCodeStreamEvent) => Promise<void> | void> = [];
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "feishu-secret": "secret" }),
      legacyTaskService: {
        ...f.createLegacyTaskService(),
        onDynamicTaskEvent: vi.fn(
          () => (listener: (event: ZCodeStreamEvent) => Promise<void> | void) => {
            streamListeners.push(listener);
            return { dispose() {} };
          },
        ),
      },
      repo: f.createMemoryRepo({
        ...f.feishuConfig,
        bots: [{ ...f.feishuConfig.bots[0]!, replyMode: "streaming_card" }],
      }) as never,
    });

    await service.handleInboundMessage({
      botId: "feishu-1",
      text: "请执行长任务",
      actor: feishuActor,
    });
    for (let index = 0; index < 46; index += 1) {
      await streamListeners[0]?.({
        type: "agent_message_chunk",
        taskId: "task-1",
        traceId: "trace-limit",
        content: `message-${index}`,
      });
      await streamListeners[0]?.({
        type: "tool_call",
        taskId: "task-1",
        traceId: "trace-limit",
        toolId: `tool-${index}`,
        title: `Read file ${index}`,
        kind: "read",
        input: { path: `/tmp/workspace/${index}.txt` },
        raw: {},
      });
    }
    await streamListeners[0]?.({
      type: "task_complete",
      taskId: "task-1",
      traceId: "trace-limit",
      stopReason: "end_turn",
    });

    const messagePosts = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("/open-apis/im/v1/messages?receive_id_type=open_id"),
    );
    expect(messagePosts).toHaveLength(2);
    const secondCardWrites = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("/open-apis/im/v1/messages/om_streaming_2"),
    );
    const secondBody = JSON.parse(String(secondCardWrites.at(-1)?.[1]?.body)) as {
      content?: string;
    };
    expect(String(secondBody.content)).toContain("message-45");
    expect(String(secondBody.content)).not.toContain("message-0");
    service.disposeAll();
  });

  it("seals the current stream, retains Plan approval, and starts a new stream card", async () => {
    let messagePostCount = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token" }));
      }
      if (url.includes("/open-apis/im/v1/messages?receive_id_type=open_id")) {
        messagePostCount += 1;
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              message_id: messagePostCount === 1 ? "om_streaming" : "om_interaction",
            },
          }),
        );
      }
      if (init?.method === "DELETE") {
        return new Response(JSON.stringify({ code: 0 }));
      }
      return new Response(JSON.stringify({ code: 0 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const repo = f.createMemoryRepo({
      ...f.feishuConfig,
      bots: [{ ...f.feishuConfig.bots[0]!, replyMode: "streaming_card" }],
    });
    const streamListeners: Array<(event: ZCodeStreamEvent) => Promise<void> | void> = [];
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "feishu-secret": "secret" }),
      legacyTaskService: {
        ...f.createLegacyTaskService(),
        onDynamicTaskEvent: vi.fn(
          () => (listener: (event: ZCodeStreamEvent) => Promise<void> | void) => {
            streamListeners.push(listener);
            return { dispose() {} };
          },
        ),
      },
      repo: repo as never,
    });

    await service.handleInboundMessage({
      botId: "feishu-1",
      text: "start",
      actor: feishuActor,
    });
    await streamListeners[0]?.({
      type: "agent_message_chunk",
      taskId: "task-1",
      traceId: "trace-1",
      content: "正在制定计划。",
    });
    await streamListeners[0]?.({
      type: "elicitation_request",
      taskId: "task-1",
      traceId: "trace-plan",
      requestId: "plan-1",
      message: "Review this implementation plan.",
      options: [{ value: "approve", label: "Approve" }],
      schema: {
        interaction: "plan_approval",
        plan: "# Plan\n\nBuild the board.",
      },
    });

    expect(messagePostCount).toBe(2);
    const sealedStreamUpdate = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).includes("/open-apis/im/v1/messages/om_streaming") && init?.method === "PATCH",
    );
    expect(sealedStreamUpdate).toBeDefined();
    expect(String(sealedStreamUpdate?.[1]?.body)).not.toContain("运行中");
    const interactionPost = fetchMock.mock.calls
      .filter(([url]) => String(url).includes("/open-apis/im/v1/messages?receive_id_type=open_id"))
      .at(-1);
    const interactionBody = JSON.parse(String(interactionPost?.[1]?.body)) as {
      content?: string;
    };
    expect(interactionBody.content).toContain("Build the board");
    const token = String(interactionBody.content).match(
      /\/elicitation ([a-f0-9]{12}) approve/u,
    )?.[1];
    expect(token).toMatch(/^[a-f0-9]{12}$/u);

    await service.handleProviderCallbackResponse("feishu", {
      botId: "feishu-1",
      event: {
        operator: { operator_id: { open_id: "ou_user" } },
        action: {
          behaviors: [
            {
              type: "callback",
              value: {
                command: `/elicitation ${token} approve`,
                zcodeCardText: "Review this implementation plan.",
              },
            },
          ],
        },
        context: { card_update_token: "interaction-token" },
      },
    });

    const retainedPlanUpdate = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/open-apis/interactive/v1/card/update"),
    );
    expect(String(retainedPlanUpdate?.[1]?.body)).toContain("Build the board");
    expect(String(retainedPlanUpdate?.[1]?.body)).not.toContain('"tag":"button"');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/open-apis/im/v1/messages/om_interaction"),
      expect.objectContaining({ method: "PATCH" }),
    );
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          String(url).includes("/open-apis/im/v1/messages/om_interaction") &&
          init?.method === "DELETE",
      ),
    ).toBe(false);
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          String(url).includes("/open-apis/im/v1/messages/om_streaming") &&
          init?.method === "DELETE",
      ),
    ).toBe(false);
    await streamListeners[0]?.({
      type: "agent_message_chunk",
      taskId: "task-1",
      traceId: "trace-continue",
      content: "开始执行计划。",
    });
    expect(messagePostCount).toBe(3);
    const continuedStreamPost = fetchMock.mock.calls
      .filter(
        ([url, init]) =>
          String(url).includes("/open-apis/im/v1/messages?receive_id_type=open_id") &&
          init?.method === "POST",
      )
      .at(-1);
    expect(String(continuedStreamPost?.[1]?.body)).toContain("开始执行计划");
    expect(String(continuedStreamPost?.[1]?.body)).not.toContain("Build the board");
    service.disposeAll();
  });

  it("continues terminal stream handling after a Feishu card request times out", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token" }));
      }
      if (url.includes("/open-apis/im/v1/messages?receive_id_type=open_id")) {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        });
      }
      return new Response(JSON.stringify({ code: 0 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const repo = f.createMemoryRepo({
      ...f.feishuConfig,
      bots: [
        {
          ...f.feishuConfig.bots[0]!,
          replyMode: "streaming_card",
        },
      ],
    });
    const streamListeners: Array<(event: ZCodeStreamEvent) => Promise<void> | void> = [];
    const service = f.createBotsService({
      runStartupBackgroundTasks: false,
      credentialService: f.createCredentialService({
        "feishu-secret": "secret",
      }),
      legacyTaskService: {
        ...f.createLegacyTaskService(),
        onDynamicTaskEvent: vi.fn(
          () => (listener: (event: ZCodeStreamEvent) => Promise<void> | void) => {
            streamListeners.push(listener);
            return { dispose() {} };
          },
        ),
      },
      repo: repo as never,
    });

    await service.handleInboundMessage({
      botId: "feishu-1",
      text: "start",
      actor: feishuActor,
    });
    const chunkPromise = streamListeners[0]?.({
      type: "agent_message_chunk",
      taskId: "task-1",
      traceId: "trace-timeout",
      content: "working",
    });
    await vi.waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).includes("/open-apis/im/v1/messages?receive_id_type=open_id"),
        ),
      ).toBe(true),
    );
    await vi.advanceTimersByTimeAsync(15_000);
    await chunkPromise;
    await vi.advanceTimersByTimeAsync(1_000);

    const completePromise = streamListeners[0]?.({
      type: "task_complete",
      taskId: "task-1",
      traceId: "trace-timeout",
      stopReason: "end_turn",
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await completePromise;

    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).includes("/open-apis/im/v1/messages?receive_id_type=open_id"),
      ),
    ).toHaveLength(1);
    expect((await service.getStatus()).botRuntime[0]?.deliveryRetryId).toBeTruthy();
    service.disposeAll();
    vi.useRealTimers();
  });

  it("serializes streamed channel replies before terminal change summaries", async () => {
    const deliveredTexts: string[] = [];
    const contentSendStarted = createDeferred<void>();
    const allowContentSend = createDeferred<void>();
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body =
        typeof init?.body === "string" ? (JSON.parse(init.body) as { text?: string }) : {};
      const text = body.text ?? "";
      if (text.includes("操作方式")) {
        contentSendStarted.resolve(undefined);
        await allowContentSend.promise;
      }
      deliveredTexts.push(text);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const repo = f.createMemoryRepo({
      ...f.baseConfig,
      bots: [
        {
          ...f.baseConfig.bots[0]!,
          webhookUrl: "https://example.test/zcode-bot-outbound",
        },
      ],
    });
    const streamListeners: Array<(event: ZCodeStreamEvent) => Promise<void> | void> = [];
    const completedTask = {
      taskId: "task-1",
      title: "Task 1",
      workspacePath: "/tmp/workspace",
      workspaceIdentity: "ssh://host/tmp/workspace",
      provider: "codex",
      status: "completed",
    };
    const legacyTaskService = {
      ...f.createLegacyTaskService(),
      listTasks: vi.fn(async () => [completedTask]),
      getTaskSnapshot: vi.fn(async () => ({
        meta: completedTask,
        messages: [
          {
            role: "assistant" as const,
            content: "操作方式",
            timestamp: 1,
            turnIndex: 1,
          },
        ],
        fileChanges: [
          {
            turnIndex: 1,
            snapshots: [
              {
                path: "/tmp/workspace/angry-birds.html",
                beforeContent: null,
                afterContent: "<html></html>\n",
                writeCount: 1,
              },
            ],
          },
        ],
      })),
      onDynamicTaskEvent: vi.fn(
        () => (listener: (event: ZCodeStreamEvent) => Promise<void> | void) => {
          streamListeners.push(listener);
          return { dispose() {} };
        },
      ),
    };
    const broadcastService = f.createBroadcastService();
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "secret-1": "secret" }),
      legacyTaskService,
      broadcastService,
      repo: repo as never,
    });
    await bind(service);
    await service.handleInboundMessage({
      botId: "webhook-1",
      text: "生成游戏",
      actor,
    });

    const contentPromise = streamListeners[0]?.({
      type: "agent_message_chunk",
      taskId: "task-1",
      traceId: "trace-1",
      content: "操作方式\n\n继续说明。",
    });
    const terminalPromise = streamListeners[0]?.({
      type: "task_complete",
      taskId: "task-1",
      traceId: "trace-1",
      stopReason: "end_turn",
    });
    await contentSendStarted.promise;
    await Promise.resolve();
    await Promise.resolve();
    expect(deliveredTexts).toEqual([]);

    allowContentSend.resolve(undefined);
    await Promise.all([contentPromise, terminalPromise]);

    expect(deliveredTexts[0]).toContain("操作方式");
    expect(deliveredTexts[0]).toContain("继续说明。");
    expect(deliveredTexts[1]).toContain("变更摘要");
    service.disposeAll();
  });

  it("sends elicitation requests to webhook channels and responds with structured content", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const repo = f.createMemoryRepo({
      ...f.baseConfig,
      bots: [
        {
          ...f.baseConfig.bots[0]!,
          webhookUrl: "https://example.test/zcode-bot-outbound",
        },
      ],
    });
    const streamListeners: Array<(event: ZCodeStreamEvent) => Promise<void> | void> = [];
    const legacyTaskService = {
      ...f.createLegacyTaskService(),
      onDynamicTaskEvent: vi.fn(
        () => (listener: (event: ZCodeStreamEvent) => Promise<void> | void) => {
          streamListeners.push(listener);
          return { dispose() {} };
        },
      ),
    };
    const broadcastService = f.createBroadcastService();
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "secret-1": "secret" }),
      legacyTaskService,
      broadcastService,
      repo: repo as never,
    });
    await bind(service);
    await service.handleInboundMessage({
      botId: "webhook-1",
      text: "启动任务",
      actor,
    });
    const subagentOrigin = {
      kind: "subagent" as const,
      agentType: "general-purpose",
      childSessionId: "child-session-1",
      parentSessionId: "task-1",
      parentToolCallId: "agent-call-1",
    };

    await streamListeners[0]?.({
      type: "elicitation_request",
      taskId: "task-1",
      traceId: "trace-elicit",
      requestId: "elicit-1",
      origin: subagentOrigin,
      message: "请选择方案",
      header: "方案",
      options: [{ value: "fast", label: "快速" }],
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      type?: string;
      elicitation?: { requestId?: string };
      selection?: { action?: string; token?: string };
    };
    expect(body.type).toBe("zcode.bot.elicitation_request");
    expect(body.elicitation?.requestId).toBe("elicit-1");
    expect(body.selection?.action).toBe("elicitation.respond");
    expect(body.selection?.token).toMatch(/^[a-f0-9]{12}$/u);
    expect(broadcastService.send).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "bots:task",
        payload: expect.objectContaining({
          event: "elicitation_request",
          taskId: "task-1",
          requestId: "elicit-1",
          workspaceIdentity: "ssh://host/tmp/workspace",
          elicitationRequest: expect.objectContaining({
            requestId: "elicit-1",
            message: "请选择方案",
            origin: subagentOrigin,
          }),
        }),
      }),
    );
    expect((await repo.readState()).bots["webhook-1"]?.pendingElicitation).toMatchObject({
      requestId: "elicit-1",
      runId: "trace-elicit",
      taskId: "task-1",
      origin: subagentOrigin,
    });

    const replies = await service.handleInboundMessage({
      botId: "webhook-1",
      text: "",
      actor,
      elicitationResponse: {
        requestId: "elicit-1",
        action: "accept",
        content: { answer: "fast" },
      },
    });

    expect(replies[0]?.text).toContain("已提交问答响应");
    expect(legacyTaskService.respondElicitation).toHaveBeenCalledWith({
      taskId: "task-1",
      workspacePath: "/tmp/workspace",
      workspaceIdentity: "ssh://host/tmp/workspace",
      runId: "trace-elicit",
      requestId: "elicit-1",
      action: "accept",
      content: { answer: "fast" },
    });
    expect(broadcastService.send).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "bots:task",
        payload: expect.objectContaining({
          event: "elicitation_resolved",
          taskId: "task-1",
          requestId: "elicit-1",
          workspaceIdentity: "ssh://host/tmp/workspace",
        }),
      }),
    );
    expect((await repo.readState()).bots["webhook-1"]?.pendingElicitation).toBeUndefined();
    service.disposeAll();
  });

  it("collects multi-select elicitation answers through numbered callbacks", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const repo = f.createMemoryRepo({
      ...f.baseConfig,
      bots: [
        {
          ...f.baseConfig.bots[0]!,
          webhookUrl: "https://example.test/zcode-bot-outbound",
        },
      ],
    });
    const streamListeners: Array<(event: ZCodeStreamEvent) => Promise<void> | void> = [];
    const legacyTaskService = {
      ...f.createLegacyTaskService(),
      onDynamicTaskEvent: vi.fn(
        () => (listener: (event: ZCodeStreamEvent) => Promise<void> | void) => {
          streamListeners.push(listener);
          return { dispose() {} };
        },
      ),
    };
    const broadcastService = f.createBroadcastService();
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "secret-1": "secret" }),
      legacyTaskService,
      broadcastService,
      repo: repo as never,
    });
    await bind(service);
    await service.handleInboundMessage({
      botId: "webhook-1",
      text: "启动任务",
      actor,
    });
    await streamListeners[0]?.({
      type: "elicitation_request",
      taskId: "task-1",
      traceId: "trace-elicit",
      requestId: "elicit-multi",
      message: "选择保障项",
      options: [
        { value: "tests", label: "测试" },
        { value: "docs", label: "文档" },
      ],
      multiSelect: true,
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      selection?: { token?: string };
    };
    const token = body.selection?.token;
    expect(token).toMatch(/^[a-f0-9]{12}$/u);

    const staleReplies = await service.handleInboundMessage({
      botId: "webhook-1",
      text: "/elicitation 1",
      actor,
    });
    expect(staleReplies[0]?.text).toContain("问答请求已过期");
    expect(legacyTaskService.respondElicitation).not.toHaveBeenCalled();

    await service.handleInboundMessage({
      botId: "webhook-1",
      text: `/elicitation ${token} 1`,
      actor,
    });
    expect(broadcastService.send).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "bots:task",
        payload: expect.objectContaining({
          event: "elicitation_request",
          requestId: "elicit-multi",
          elicitationRequest: expect.objectContaining({
            currentQuestionIndex: 0,
            answerDrafts: { answer_0: ["tests"] },
          }),
        }),
      }),
    );
    await service.handleInboundMessage({
      botId: "webhook-1",
      text: `/elicitation ${token} 2`,
      actor,
    });
    expect(broadcastService.send).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "bots:task",
        payload: expect.objectContaining({
          event: "elicitation_request",
          requestId: "elicit-multi",
          elicitationRequest: expect.objectContaining({
            currentQuestionIndex: 0,
            answerDrafts: { answer_0: ["tests", "docs"] },
          }),
        }),
      }),
    );
    const doneReplies = await service.handleInboundMessage({
      botId: "webhook-1",
      text: `/elicitation ${token} 3`,
      actor,
    });

    expect(doneReplies[0]?.text).toContain("已提交问答响应");
    expect(legacyTaskService.respondElicitation).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-1",
        runId: "trace-elicit",
        requestId: "elicit-multi",
        content: {
          answers: { 选择保障项: "tests, docs" },
          answer_0: ["tests", "docs"],
          answer: ["tests", "docs"],
        },
      }),
    );
    service.disposeAll();
  });

  it("replaces the Feishu interaction card when custom answer input is expanded", async () => {
    let messagePostCount = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token" }));
      }
      if (url.includes("/open-apis/im/v1/messages?receive_id_type=") && init?.method === "POST") {
        messagePostCount += 1;
        return new Response(
          JSON.stringify({ code: 0, data: { message_id: `om_question_${messagePostCount}` } }),
        );
      }
      if (url.includes("/open-apis/interactive/v1/card/update")) {
        return new Response(JSON.stringify({ code: 0 }));
      }
      return new Response(JSON.stringify({ code: 0 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const repo = f.createMemoryRepo(f.feishuConfig, {
      version: 3,
      bots: {
        "feishu-1": {
          botId: "feishu-1",
          workspacePath: "/tmp/workspace",
          workspaceIdentity: "ssh://host/tmp/workspace",
          workspaceId: "ssh://host/tmp/workspace",
          mode: "task",
          activeTaskId: "task-1",
          updatedAt: Date.now(),
        },
      },
    });
    const streamListeners: Array<(event: ZCodeStreamEvent) => Promise<void> | void> = [];
    const legacyTaskService = {
      ...f.createLegacyTaskService(),
      onDynamicTaskEvent: vi.fn(
        () => (listener: (event: ZCodeStreamEvent) => Promise<void> | void) => {
          streamListeners.push(listener);
          return { dispose() {} };
        },
      ),
    };
    const service = f.createBotsService({
      credentialService: f.createCredentialService({
        "feishu-secret": "secret",
      }),
      legacyTaskService,
      repo: repo as never,
    });

    await service.handleInboundMessage({
      botId: "feishu-1",
      text: "启动任务",
      actor: feishuActor,
    });
    await streamListeners[0]?.({
      type: "elicitation_request",
      taskId: "task-1",
      traceId: "trace-elicit",
      requestId: "elicit-feishu",
      message: "你希望游戏有什么功能？",
      options: [
        { value: "base", label: "基础玩法" },
        { value: "score", label: "分数系统" },
      ],
      multiSelect: true,
    });

    const initialSendCount = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("/open-apis/im/v1/messages?receive_id_type="),
    ).length;
    const firstCardCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/open-apis/im/v1/messages"),
    );
    const firstCardBody = JSON.parse(String(firstCardCall?.[1]?.body)) as {
      content?: string;
    };
    const token = String(firstCardBody.content).match(
      /\/elicitation ([a-f0-9]{12}) __form__:/u,
    )?.[1];
    expect(token).toMatch(/^[a-f0-9]{12}$/u);

    const toggleResponse = await service.handleProviderCallbackResponse("feishu", {
      botId: "feishu-1",
      event: {
        operator: { operator_id: { open_id: "ou_user" } },
        action: {
          behaviors: [
            {
              type: "callback",
              value: {
                command: `/elicitation ${token} base`,
                zcodeCardText: "Question",
              },
            },
          ],
        },
        context: { card_update_token: "ask-card-token-toggle" },
      },
    });

    expect(toggleResponse.ok).toBe(true);
    expect(toggleResponse.replies[0]?.elicitation).toMatchObject({
      requestId: "elicit-feishu",
      status: "pending",
      answers: { "0": ["base"] },
    });

    const customResponse = await service.handleProviderCallbackResponse("feishu", {
      botId: "feishu-1",
      event: {
        operator: { operator_id: { open_id: "ou_user" } },
        action: {
          behaviors: [
            {
              type: "callback",
              value: {
                command: `/elicitation ${token} __custom__`,
                zcodeCardText: "Question",
              },
            },
          ],
        },
        context: { card_update_token: "ask-card-token-custom" },
      },
    });

    expect(customResponse.ok).toBe(true);
    expect(customResponse.replies[0]?.elicitation).toMatchObject({
      requestId: "elicit-feishu",
      status: "pending",
      answers: { "0": ["base"] },
      expandedCustomAnswerQuestionIndexes: [0],
    });
    const customFormUpdate = fetchMock.mock.calls
      .filter(([url]) => String(url).includes("/open-apis/interactive/v1/card/update"))
      .at(-1);
    const customFormBody = JSON.parse(String(customFormUpdate?.[1]?.body)) as { card?: unknown };
    expect(JSON.stringify(customFormBody.card)).toContain('"tag":"form"');
    expect(JSON.stringify(customFormBody.card)).toContain('"tag":"input"');

    const response = await service.handleProviderCallbackResponse("feishu", {
      botId: "feishu-1",
      event: {
        operator: { operator_id: { open_id: "ou_user" } },
        action: {
          behaviors: [
            {
              type: "callback",
              value: {
                command: `/elicitation ${token} __form__:`,
                zcodeCardText: "Question",
              },
            },
          ],
          form_value: { answer: "排行榜" },
        },
        context: { card_update_token: "ask-card-token" },
      },
    });

    expect(response.ok).toBe(true);
    expect(response.replies[0]?.elicitation).toMatchObject({
      requestId: "elicit-feishu",
      status: "completed",
    });
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) =>
          String(url).includes("/open-apis/im/v1/messages?receive_id_type=") &&
          init?.method === "POST",
      ),
    ).toHaveLength(initialSendCount);
    const deleteCalls = fetchMock.mock.calls.filter(
      ([url, init]) =>
        String(url).includes("/open-apis/im/v1/messages/om_question_") && init?.method === "DELETE",
    );
    expect(deleteCalls).toHaveLength(0);
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).includes("/open-apis/interactive/v1/card/update"),
      ),
    ).toHaveLength(3);
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) =>
          String(url).includes("/open-apis/im/v1/messages/om_question_") &&
          init?.method === "PATCH",
      ),
    ).toHaveLength(3);
    expect(legacyTaskService.respondElicitation).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-1",
        runId: "trace-elicit",
        requestId: "elicit-feishu",
        content: {
          answers: { "你希望游戏有什么功能？": "base, 排行榜" },
          answer_0: ["base", "排行榜"],
          answer: ["base", "排行榜"],
        },
      }),
    );
    service.disposeAll();
  });

  it("sends the next Feishu question after the answered card is acknowledged", async () => {
    let messagePostCount = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token" }));
      }
      if (url.includes("/open-apis/interactive/v1/card/update")) {
        return new Response(JSON.stringify({ code: 0 }));
      }
      if (url.includes("/open-apis/im/v1/messages?receive_id_type=") && init?.method === "POST") {
        messagePostCount += 1;
        return new Response(
          JSON.stringify({ code: 0, data: { message_id: `om_question_${messagePostCount}` } }),
        );
      }
      return new Response(JSON.stringify({ code: 0 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const repo = f.createMemoryRepo(f.feishuConfig, {
      version: 3,
      bots: {
        "feishu-1": {
          botId: "feishu-1",
          workspacePath: "/tmp/workspace",
          workspaceIdentity: "ssh://host/tmp/workspace",
          workspaceId: "ssh://host/tmp/workspace",
          mode: "task",
          activeTaskId: "task-1",
          updatedAt: Date.now(),
        },
      },
    });
    const streamListeners: Array<(event: ZCodeStreamEvent) => Promise<void> | void> = [];
    const legacyTaskService = {
      ...f.createLegacyTaskService(),
      onDynamicTaskEvent: vi.fn(
        () => (listener: (event: ZCodeStreamEvent) => Promise<void> | void) => {
          streamListeners.push(listener);
          return { dispose() {} };
        },
      ),
    };
    const broadcastService = f.createBroadcastService();
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "feishu-secret": "secret" }),
      legacyTaskService,
      broadcastService,
      repo: repo as never,
    });

    await service.handleInboundMessage({
      botId: "feishu-1",
      text: "启动任务",
      actor: feishuActor,
    });
    await streamListeners[0]?.({
      type: "elicitation_request",
      taskId: "task-1",
      traceId: "trace-elicit-two",
      requestId: "elicit-feishu-two",
      message: "选择技术方案",
      options: [{ value: "web", label: "纯前端" }],
      questions: [
        {
          question: "选择技术方案",
          header: "技术方案",
          options: [{ value: "web", label: "纯前端" }],
        },
        {
          question: "选择棋盘尺寸",
          header: "棋盘",
          options: [{ value: "15", label: "15 × 15" }],
        },
      ],
    });
    const firstCardCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/open-apis/im/v1/messages"),
    );
    const firstCardBody = JSON.parse(String(firstCardCall?.[1]?.body)) as {
      content?: string;
    };
    const token = String(firstCardBody.content).match(/\/elicitation ([a-f0-9]{12}) web/u)?.[1];
    expect(token).toMatch(/^[a-f0-9]{12}$/u);
    const response = await service.handleProviderCallbackResponse("feishu", {
      botId: "feishu-1",
      event: {
        operator: { operator_id: { open_id: "ou_user" } },
        action: {
          behaviors: [
            {
              type: "callback",
              value: {
                command: `/elicitation ${token} web`,
                zcodeCardText: "Question",
              },
            },
          ],
        },
        context: { card_update_token: "ask-next-card-token" },
      },
    });
    expect(response.ok).toBe(true);
    expect(response.replies[0]?.elicitation).toMatchObject({
      requestId: "elicit-feishu-two",
      currentQuestionIndex: 1,
      status: "pending",
      answers: { "0": ["web"] },
    });
    const messageCalls = fetchMock.mock.calls.filter(
      ([url, init]) =>
        String(url).includes("/open-apis/im/v1/messages?receive_id_type=") &&
        init?.method === "POST",
    );
    expect(messageCalls).toHaveLength(1);
    const updateCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/open-apis/interactive/v1/card/update"),
    );
    const updateBody = JSON.parse(String(updateCall?.[1]?.body)) as { card?: unknown };
    expect(JSON.stringify(updateBody.card)).toContain("2/2");
    expect(JSON.stringify(updateBody.card)).toContain("选择棋盘尺寸");
    const updatedCardJson = JSON.stringify(updateBody.card);
    expect(updatedCardJson).toContain("选择技术方案");
    expect(updatedCardJson).toContain("纯前端");
    expect(updatedCardJson.indexOf("选择技术方案")).toBeLessThan(
      updatedCardJson.indexOf('"tag":"hr"'),
    );
    expect(updatedCardJson.indexOf('"tag":"hr"')).toBeLessThan(
      updatedCardJson.indexOf("选择棋盘尺寸"),
    );
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/open-apis/im/v1/messages/om_question_1"),
      expect.objectContaining({ method: "PATCH" }),
    );
    expect(legacyTaskService.respondElicitation).not.toHaveBeenCalled();
    service.disposeAll();
  });

  it("submits Feishu single-select AskUserQuestion preset answers immediately", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token" }));
      }
      if (url.includes("/open-apis/im/v1/messages")) {
        return new Response(JSON.stringify({ code: 0, data: { message_id: "om_question" } }));
      }
      if (url.includes("/open-apis/interactive/v1/card/update")) {
        return new Response(JSON.stringify({ code: 0 }));
      }
      return new Response(JSON.stringify({ code: 0 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const repo = f.createMemoryRepo(f.feishuConfig, {
      version: 3,
      bots: {
        "feishu-1": {
          botId: "feishu-1",
          workspacePath: "/tmp/workspace",
          workspaceIdentity: "ssh://host/tmp/workspace",
          workspaceId: "ssh://host/tmp/workspace",
          mode: "task",
          activeTaskId: "task-1",
          updatedAt: Date.now(),
        },
      },
    });
    const streamListeners: Array<(event: ZCodeStreamEvent) => Promise<void> | void> = [];
    const legacyTaskService = {
      ...f.createLegacyTaskService(),
      onDynamicTaskEvent: vi.fn(
        () => (listener: (event: ZCodeStreamEvent) => Promise<void> | void) => {
          streamListeners.push(listener);
          return { dispose() {} };
        },
      ),
    };
    const service = f.createBotsService({
      credentialService: f.createCredentialService({
        "feishu-secret": "secret",
      }),
      legacyTaskService,
      repo: repo as never,
    });

    await service.handleInboundMessage({
      botId: "feishu-1",
      text: "启动任务",
      actor: feishuActor,
    });
    await streamListeners[0]?.({
      type: "elicitation_request",
      taskId: "task-1",
      traceId: "trace-elicit-single",
      requestId: "elicit-feishu-single",
      message: "你想在哪里运行贪吃蛇游戏？",
      options: [{ value: "web", label: "网页版 (HTML/CSS/JS)" }],
    });

    const firstCardCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/open-apis/im/v1/messages"),
    );
    const firstCardBody = JSON.parse(String(firstCardCall?.[1]?.body)) as {
      content?: string;
    };
    const token = String(firstCardBody.content).match(/\/elicitation ([a-f0-9]{12}) web/u)?.[1];
    expect(token).toMatch(/^[a-f0-9]{12}$/u);

    const response = await service.handleProviderCallbackResponse("feishu", {
      botId: "feishu-1",
      event: {
        operator: { operator_id: { open_id: "ou_user" } },
        action: {
          behaviors: [
            {
              type: "callback",
              value: {
                command: `/elicitation ${token} web`,
                zcodeCardText: "Question",
              },
            },
          ],
        },
        context: { card_update_token: "ask-single-card-token" },
      },
    });

    expect(response.ok).toBe(true);
    expect(response.replies[0]?.elicitation).toMatchObject({
      requestId: "elicit-feishu-single",
      status: "completed",
    });
    expect(legacyTaskService.respondElicitation).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-1",
        runId: "trace-elicit-single",
        requestId: "elicit-feishu-single",
        content: {
          answers: { "你想在哪里运行贪吃蛇游戏？": "web" },
          answer_0: "web",
          answer: "web",
        },
      }),
    );
    const deleteCalls = fetchMock.mock.calls.filter(
      ([url, init]) =>
        String(url).includes("/open-apis/im/v1/messages/om_question") && init?.method === "DELETE",
    );
    expect(deleteCalls).toHaveLength(0);
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).includes("/open-apis/interactive/v1/card/update"),
      ),
    ).toHaveLength(1);
    service.disposeAll();
  });

  it("serializes concurrent elicitation replies for the same actor", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const repo = f.createMemoryRepo({
      ...f.baseConfig,
      bots: [
        {
          ...f.baseConfig.bots[0]!,
          webhookUrl: "https://example.test/zcode-bot-outbound",
        },
      ],
    });
    const streamListeners: Array<(event: ZCodeStreamEvent) => Promise<void> | void> = [];
    const deferredRespond = createDeferred<boolean>();
    const legacyTaskService = {
      ...f.createLegacyTaskService(),
      respondElicitation: vi.fn(() => deferredRespond.promise),
      onDynamicTaskEvent: vi.fn(
        () => (listener: (event: ZCodeStreamEvent) => Promise<void> | void) => {
          streamListeners.push(listener);
          return { dispose() {} };
        },
      ),
    };
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "secret-1": "secret" }),
      legacyTaskService,
      repo: repo as never,
    });
    await bind(service);
    await service.handleInboundMessage({
      botId: "webhook-1",
      text: "启动任务",
      actor,
    });
    await streamListeners[0]?.({
      type: "elicitation_request",
      taskId: "task-1",
      traceId: "trace-elicit",
      requestId: "elicit-concurrent",
      message: "选择方案",
      options: [{ value: "fast", label: "快速" }],
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      selection?: { token?: string };
    };
    const token = body.selection?.token;
    expect(token).toMatch(/^[a-f0-9]{12}$/u);

    const firstReply = service.handleInboundMessage({
      botId: "webhook-1",
      text: `/elicitation ${token} 1`,
      actor: { ...actor, providerMessageId: "reply-1" },
    });
    const secondReply = service.handleInboundMessage({
      botId: "webhook-1",
      text: `/elicitation ${token} 1`,
      actor: { ...actor, providerMessageId: "reply-2" },
    });
    await vi.waitFor(() => {
      expect(legacyTaskService.respondElicitation).toHaveBeenCalledTimes(1);
    });
    deferredRespond.resolve(true);

    const [firstReplies, secondReplies] = await Promise.all([firstReply, secondReply]);
    expect(firstReplies[0]?.text).toContain("已提交问答响应");
    expect(secondReplies[0]?.text).toContain("问答请求已过期");
    expect(legacyTaskService.respondElicitation).toHaveBeenCalledTimes(1);
    service.disposeAll();
  });

  it("keeps an elicitation retryable when the v4 interaction ACK fails", async () => {
    const repo = f.createMemoryRepo(f.weixinConfig, {
      version: 3,
      bots: {
        "weixin-1": {
          botId: "weixin-1",
          workspacePath: "/tmp/workspace",
          workspaceId: "/tmp/workspace",
          mode: "task",
          activeTaskId: "task-1",
          pendingElicitation: {
            taskId: "task-1",
            requestId: "elicit-retry",
            runId: "trace-retry",
            currentQuestionIndex: 0,
            questions: [
              {
                question: "是否继续？",
                header: "确认",
                options: [{ value: "yes", label: "继续" }],
              },
            ],
            answers: {},
          },
          updatedAt: Date.now(),
        },
      },
    });
    const legacyTaskService = f.createLegacyTaskService();
    vi.mocked(legacyTaskService.respondElicitation)
      .mockRejectedValueOnce(new Error("temporary v4 failure"))
      .mockResolvedValueOnce(true);
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "weixin-token": "token" }),
      legacyTaskService,
      repo: repo as never,
    });

    await expect(
      service.handleInboundMessage({
        botId: "weixin-1",
        text: "继续",
        actor: weixinActor,
      }),
    ).rejects.toThrow("temporary v4 failure");
    const pendingAfterFailure = (await repo.readState()).bots["weixin-1"]?.pendingElicitation;
    expect(pendingAfterFailure).toMatchObject({ requestId: "elicit-retry" });
    expect(pendingAfterFailure?.handledAt).toBeUndefined();

    const retry = await service.handleInboundMessage({
      botId: "weixin-1",
      text: "继续",
      actor: weixinActor,
    });
    expect(retry[0]?.text).toContain("已提交问答响应");
    expect(legacyTaskService.respondElicitation).toHaveBeenCalledTimes(2);
    service.disposeAll();
  });

  it("keeps a permission retryable when the v4 interaction ACK fails", async () => {
    const repo = f.createMemoryRepo(f.telegramConfig, {
      version: 3,
      bots: {
        "telegram-1": {
          botId: "telegram-1",
          workspacePath: "/tmp/workspace",
          workspaceId: "/tmp/workspace",
          mode: "task",
          activeTaskId: "task-1",
          pendingPermissionOptions: [
            {
              requestId: "permission-retry",
              optionId: "allow_once",
              command: "approve",
              label: "允许",
              response: { decision: "allow", reason: "Approved by bot" },
            },
          ],
          updatedAt: Date.now(),
        },
      },
    });
    const legacyTaskService = f.createLegacyTaskService();
    vi.mocked(legacyTaskService.respondPermission)
      .mockRejectedValueOnce(new Error("temporary permission failure"))
      .mockResolvedValueOnce(true);
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "telegram-token": "token" }),
      legacyTaskService,
      repo: repo as never,
    });
    const telegramActor = {
      provider: "telegram" as const,
      botId: "telegram-1",
      providerUserId: "user-1",
      chatType: "private" as const,
    };

    await expect(
      service.handleInboundMessage({
        botId: "telegram-1",
        text: "/permission 1",
        actor: telegramActor,
      }),
    ).rejects.toThrow("temporary permission failure");
    const permissionAfterFailure = (await repo.readState()).bots["telegram-1"]
      ?.pendingPermissionOptions?.[0];
    expect(permissionAfterFailure?.handledAt).toBeUndefined();

    const retry = await service.handleInboundMessage({
      botId: "telegram-1",
      text: "/permission 1",
      actor: telegramActor,
    });
    expect(retry[0]?.text).toContain("已提交权限响应");
    expect(legacyTaskService.respondPermission).toHaveBeenCalledTimes(2);
    service.disposeAll();
  });

  it("returns ok=false and skips provider ACK when callback business handling fails", async () => {
    const repo = f.createMemoryRepo(f.telegramConfig, {
      version: 3,
      bots: {
        "telegram-1": {
          botId: "telegram-1",
          workspacePath: "/tmp/workspace",
          workspaceId: "/tmp/workspace",
          mode: "task",
          activeTaskId: "task-1",
          pendingPermissionOptions: [
            {
              requestId: "permission-provider-retry",
              optionId: "allow_once",
              command: "approve",
              label: "允许",
              response: { decision: "allow", reason: "Approved by bot" },
            },
          ],
          updatedAt: Date.now(),
        },
      },
    });
    const legacyTaskService = f.createLegacyTaskService();
    vi.mocked(legacyTaskService.respondPermission).mockRejectedValue(
      new Error("temporary permission failure"),
    );
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const service = f.createBotsService({
      credentialService: f.createCredentialService({
        "telegram-token": "token",
      }),
      legacyTaskService,
      repo: repo as never,
    });

    const response = await service.handleProviderCallbackResponse("telegram", {
      botId: "telegram-1",
      update: {
        callback_query: {
          id: "callback-provider-retry",
          data: "zc:permission:1",
          from: { id: "user-1", username: "user" },
          message: {
            chat: { id: "user-1", type: "private" },
            message_id: 7,
          },
        },
      },
    });

    expect(response).toMatchObject({ ok: false, status: 503 });
    expect(
      (await repo.readState()).bots["telegram-1"]?.pendingPermissionOptions?.[0]?.handledAt,
    ).toBeUndefined();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/answerCallbackQuery"))).toBe(
      false,
    );
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/sendMessage"))).toBe(true);
    service.disposeAll();
  });

  it("maps comma-separated elicitation text numbers to option values", async () => {
    const repo = f.createMemoryRepo(f.weixinConfig, {
      version: 3,
      bots: {
        "weixin-1": {
          botId: "weixin-1",
          workspacePath: "/tmp/workspace",
          workspaceIdentity: "ssh://host/tmp/workspace",
          workspaceId: "ssh://host/tmp/workspace",
          mode: "task",
          activeTaskId: "task-1",
          pendingElicitation: {
            taskId: "task-1",
            requestId: "elicit-text",
            runId: "trace-text",
            currentQuestionIndex: 0,
            questions: [
              {
                question: "选择保障项",
                header: "选择保障项",
                multiSelect: true,
                options: [
                  { value: "tests", label: "测试" },
                  { value: "docs", label: "文档" },
                ],
              },
            ],
            answers: {},
          },
          updatedAt: Date.now(),
        },
      },
    });
    const legacyTaskService = f.createLegacyTaskService();
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "weixin-token": "token" }),
      legacyTaskService,
      repo: repo as never,
    });

    const replies = await service.handleInboundMessage({
      botId: "weixin-1",
      text: "1,2",
      actor: weixinActor,
    });

    expect(replies[0]?.text).toContain("已提交问答响应");
    expect(legacyTaskService.respondElicitation).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "elicit-text",
        runId: "trace-text",
        workspaceIdentity: "ssh://host/tmp/workspace",
        content: expect.objectContaining({
          answer_0: ["tests", "docs"],
          answer: ["tests", "docs"],
        }),
      }),
    );
    service.disposeAll();
  });

  it("allows skipping a single-select question before submitting a partial answer", async () => {
    const repo = f.createMemoryRepo(f.weixinConfig, {
      version: 3,
      bots: {
        "weixin-1": {
          botId: "weixin-1",
          workspacePath: "/tmp/workspace",
          workspaceIdentity: "ssh://host/tmp/workspace",
          workspaceId: "ssh://host/tmp/workspace",
          mode: "task",
          activeTaskId: "task-1",
          pendingElicitation: {
            taskId: "task-1",
            requestId: "elicit-partial",
            runId: "trace-partial",
            currentQuestionIndex: 0,
            questions: [
              {
                question: "选择方案",
                header: "方案",
                options: [
                  { value: "fast", label: "快速" },
                  { value: "safe", label: "稳妥" },
                ],
              },
              {
                question: "选择保障项",
                header: "保障项",
                options: [
                  { value: "tests", label: "测试" },
                  { value: "docs", label: "文档" },
                ],
              },
            ],
            answers: {},
          },
          updatedAt: Date.now(),
        },
      },
    });
    const legacyTaskService = f.createLegacyTaskService();
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "weixin-token": "token" }),
      legacyTaskService,
      repo: repo as never,
    });

    const promptReplies = await service.handleInboundMessage({
      botId: "weixin-1",
      text: "",
      actor: weixinActor,
    });
    expect(promptReplies[0]?.text).toContain("3. 跳过");

    const skipReplies = await service.handleInboundMessage({
      botId: "weixin-1",
      text: "3",
      actor: weixinActor,
    });

    expect(skipReplies[0]?.text).toContain("选择保障项");
    expect((await repo.readState()).bots["weixin-1"]?.pendingElicitation).toMatchObject({
      currentQuestionIndex: 1,
      answers: {},
    });

    const replies = await service.handleInboundMessage({
      botId: "weixin-1",
      text: "1",
      actor: weixinActor,
    });

    expect(replies[0]?.text).toContain("已提交问答响应");
    expect(legacyTaskService.respondElicitation).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "elicit-partial",
        content: {
          answers: { 选择保障项: "tests" },
          answer_1: "tests",
        },
      }),
    );
    service.disposeAll();
  });

  it("submits zero answers when the final bot single-select question is skipped", async () => {
    const repo = f.createMemoryRepo(f.weixinConfig, {
      version: 3,
      bots: {
        "weixin-1": {
          botId: "weixin-1",
          workspacePath: "/tmp/workspace",
          workspaceIdentity: "ssh://host/tmp/workspace",
          workspaceId: "ssh://host/tmp/workspace",
          mode: "task",
          activeTaskId: "task-1",
          pendingElicitation: {
            taskId: "task-1",
            requestId: "elicit-empty",
            runId: "trace-empty",
            currentQuestionIndex: 0,
            questions: [
              {
                question: "选择方案",
                header: "方案",
                options: [
                  { value: "fast", label: "快速" },
                  { value: "safe", label: "稳妥" },
                ],
              },
            ],
            answers: {},
          },
          updatedAt: Date.now(),
        },
      },
    });
    const legacyTaskService = f.createLegacyTaskService();
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "weixin-token": "token" }),
      legacyTaskService,
      repo: repo as never,
    });

    const replies = await service.handleInboundMessage({
      botId: "weixin-1",
      text: "3",
      actor: weixinActor,
    });

    expect(replies[0]?.text).toContain("已提交问答响应");
    expect(legacyTaskService.respondElicitation).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "elicit-empty",
        content: { answers: {} },
      }),
    );
    service.disposeAll();
  });

  it("preserves skip-like option labels and custom text as bot answers", async () => {
    const repo = f.createMemoryRepo(f.weixinConfig, {
      version: 3,
      bots: {
        "weixin-1": {
          botId: "weixin-1",
          workspacePath: "/tmp/workspace",
          workspaceIdentity: "ssh://host/tmp/workspace",
          workspaceId: "ssh://host/tmp/workspace",
          mode: "task",
          activeTaskId: "task-1",
          pendingElicitation: {
            taskId: "task-1",
            requestId: "elicit-skip-labels",
            runId: "trace-skip-labels",
            currentQuestionIndex: 0,
            questions: [
              {
                question: "选择按钮文案",
                header: "文案",
                multiSelect: true,
                options: [
                  { value: "Skip", label: "Skip" },
                  { value: "下一题", label: "下一题" },
                  { value: "__skip__", label: "__skip__" },
                  { value: "Keep", label: "Keep" },
                ],
              },
            ],
            answers: {},
          },
          updatedAt: Date.now(),
        },
      },
    });
    const legacyTaskService = f.createLegacyTaskService();
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "weixin-token": "token" }),
      legacyTaskService,
      repo: repo as never,
    });

    await service.handleInboundMessage({
      botId: "weixin-1",
      text: "Skip,下一题,__skip__,next",
      actor: weixinActor,
    });

    expect(legacyTaskService.respondElicitation).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "elicit-skip-labels",
        content: expect.objectContaining({
          answer_0: ["Skip", "下一题", "__skip__", "next"],
        }),
      }),
    );
    service.disposeAll();
  });

  it("creates a task from an attachment-only bot message with the default prompt", async () => {
    vi.stubEnv("ZCODE_DATA_BASE_DIR", `/tmp/zcode-bot-attachments-${Date.now()}`);
    const repo = f.createMemoryRepo(f.baseConfig);
    const legacyTaskService = f.createLegacyTaskService();
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "secret-1": "secret" }),
      legacyTaskService,
      repo: repo as never,
    });
    await bind(service);

    const replies = await service.handleInboundMessage({
      botId: "webhook-1",
      text: "",
      attachments: [
        {
          id: "img-1",
          kind: "image",
          filename: "demo.png",
          mimeType: "image/png",
          dataBase64: "AQID",
        },
      ],
      actor,
    });

    expect(replies).toEqual([]);
    expect(legacyTaskService.sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining(
          "请查看附件并根据内容协助我。\n\n附件：demo.png (image/png, 3B)，已作为图片输入提供，并保存到：",
        ),
        attachments: [
          expect.objectContaining({
            kind: "image",
            filename: "demo.png",
            mimeType: "image/png",
            dataBase64: "AQID",
            localPath: expect.any(String),
          }),
        ],
      }),
    );
    expect(legacyTaskService.sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("不要下载或访问临时/远程 URL"),
      }),
    );
    service.disposeAll();
  });

  it("adds unsupported bot files to the prompt as cached path context", async () => {
    vi.stubEnv("ZCODE_DATA_BASE_DIR", `/tmp/zcode-bot-files-${Date.now()}`);
    const repo = f.createMemoryRepo(f.baseConfig);
    const legacyTaskService = f.createLegacyTaskService();
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "secret-1": "secret" }),
      legacyTaskService,
      repo: repo as never,
    });
    await bind(service);

    await service.handleInboundMessage({
      botId: "webhook-1",
      text: "总结这个文件",
      attachments: [
        {
          id: "file-1",
          kind: "file",
          filename: "notes.txt",
          mimeType: "text/plain",
          dataBase64: Buffer.from("hello").toString("base64"),
        },
      ],
      actor,
    });

    expect(legacyTaskService.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ v4Create: true }),
    );
    expect(legacyTaskService.sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining(
          "总结这个文件\n\n附件：notes.txt (text/plain, 5B)，已保存到：",
        ),
        attachments: undefined,
      }),
    );
    service.disposeAll();
  });

  it("returns an actionable attachment download error instead of provider internals", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("missing", { status: 404 })),
    );
    const repo = f.createMemoryRepo(f.baseConfig);
    const legacyTaskService = f.createLegacyTaskService();
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "secret-1": "secret" }),
      legacyTaskService,
      repo: repo as never,
    });
    await bind(service);

    const replies = await service.handleInboundMessage({
      botId: "webhook-1",
      text: "看一下这个附件",
      attachments: [
        {
          id: "file-404",
          kind: "file",
          filename: "missing.txt",
          mimeType: "text/plain",
          downloadUrl: "https://example.test/missing.txt",
        },
      ],
      actor,
    });

    expect(replies.map((reply) => reply.text)).toEqual([
      "附件处理失败：无法下载附件。文件可能已过期、已撤回，或机器人没有读取权限。请重新发送附件后再试。",
    ]);
    expect(legacyTaskService.createTask).not.toHaveBeenCalled();
    service.disposeAll();
  });

  it("blocks a disconnected remote workspace message without reconnecting", async () => {
    const repo = f.createMemoryRepo(f.baseConfig);
    const legacyTaskService = f.createLegacyTaskService();
    const isConnected = vi.fn(async () => false);
    const ensureConnected = vi.fn(async () => ({ ok: true }));
    const getLegacyTaskService = vi.fn(async () => legacyTaskService);
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "secret-1": "secret" }),
      legacyTaskService,
      remoteWorkspaceService: {
        isConnected,
        ensureConnected,
        getLegacyTaskService,
      },
      repo: repo as never,
    });
    await bind(service);

    const replies = await service.handleInboundMessage({
      botId: "webhook-1",
      text: "请检查当前项目",
      actor,
    });

    expect(replies.map((reply) => reply.text)).toEqual([
      "当前远端项目 /tmp/workspace 未连接。请先发送 **/重连**，连接恢复后再重试。上一条请求未执行。",
    ]);
    expect(isConnected).toHaveBeenCalledWith({
      workspacePath: "/tmp/workspace",
      workspaceIdentity: "ssh://host/tmp/workspace",
    });
    expect(ensureConnected).not.toHaveBeenCalled();
    expect(getLegacyTaskService).not.toHaveBeenCalled();
    expect(legacyTaskService.createTask).not.toHaveBeenCalled();
    service.disposeAll();
  });

  it("returns a clear reconnect failure from /reconnect", async () => {
    const repo = f.createMemoryRepo(f.baseConfig);
    const legacyTaskService = f.createLegacyTaskService();
    const ensureConnected = vi.fn(async () => ({
      ok: false,
      message: "SSH 认证失败",
    }));
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "secret-1": "secret" }),
      legacyTaskService,
      remoteWorkspaceService: {
        isConnected: vi.fn(async () => false),
        ensureConnected,
        getLegacyTaskService: vi.fn(async () => legacyTaskService),
      },
      repo: repo as never,
    });
    await bind(service);

    const replies = await service.handleInboundMessage({
      botId: "webhook-1",
      text: "/reconnect",
      actor,
    });

    expect(replies.map((reply) => reply.text)).toEqual([
      "当前远端项目 /tmp/workspace 重连失败：SSH 认证失败\n上一条请求没有执行。",
    ]);
    expect(ensureConnected).toHaveBeenCalledWith({
      workspacePath: "/tmp/workspace",
      workspaceIdentity: "ssh://host/tmp/workspace",
    });
    expect(legacyTaskService.createTask).not.toHaveBeenCalled();
    service.disposeAll();
  });

  it("blocks remote runtime commands when reconnect service is unavailable", async () => {
    const repo = f.createMemoryRepo(f.baseConfig);
    const legacyTaskService = f.createLegacyTaskService();
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "secret-1": "secret" }),
      legacyTaskService,
      remoteWorkspaceService: undefined,
      repo: repo as never,
    });
    await bind(service);

    const replies = await service.handleInboundMessage({
      botId: "webhook-1",
      text: "/model",
      actor,
    });

    expect(replies.map((reply) => reply.text)).toEqual([
      "当前远端项目 /tmp/workspace 未连接。请先发送 **/重连**，连接恢复后再重试。上一条请求未执行。",
    ]);
    expect(legacyTaskService.createTask).not.toHaveBeenCalled();
    service.disposeAll();
  });

  it("switches to a disconnected remote workspace without reconnecting", async () => {
    const repo = f.createMemoryRepo(f.baseConfig);
    const legacyTaskService = f.createLegacyTaskService();
    const ensureConnected = vi.fn(async () => ({ ok: true }));
    const getLegacyTaskService = vi.fn(async () => legacyTaskService);
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "secret-1": "secret" }),
      legacyTaskService,
      remoteWorkspaceService: {
        isConnected: vi.fn(async () => false),
        ensureConnected,
        getLegacyTaskService,
      },
      repo: repo as never,
    });
    await bind(service);

    const replies = await service.handleInboundMessage({
      botId: "webhook-1",
      text: "/workspace 1",
      actor,
    });

    expect(replies.map((reply) => reply.text)).toEqual([
      [
        "工作区: workspace",
        "模型: -",
        "------",
        "任务: 草稿",
        "状态: 远端未连接",
        "当前远端项目 /tmp/workspace 未连接。请发送 **/重连** 恢复连接。",
      ].join("\n"),
    ]);
    expect(ensureConnected).not.toHaveBeenCalled();
    expect(getLegacyTaskService).not.toHaveBeenCalled();
    service.disposeAll();
  });

  it("allows help and lightweight status when reconnect service is unavailable", async () => {
    const repo = f.createMemoryRepo(f.baseConfig);
    const legacyTaskService = f.createLegacyTaskService();
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "secret-1": "secret" }),
      legacyTaskService,
      remoteWorkspaceService: undefined,
      repo: repo as never,
    });
    await bind(service);
    vi.mocked(legacyTaskService.listTasks).mockClear();

    const helpReplies = await service.handleInboundMessage({
      botId: "webhook-1",
      text: "/help",
      actor,
    });
    const statusReplies = await service.handleInboundMessage({
      botId: "webhook-1",
      text: "/status",
      actor,
    });

    expect(helpReplies[0]?.text).toContain("ZCode 机器人命令");
    expect(statusReplies[0]?.text).toContain("状态: 远端未连接");
    expect(statusReplies[0]?.text).toContain("**/重连**");
    expect(legacyTaskService.listTasks).not.toHaveBeenCalled();
    expect(legacyTaskService.createTask).not.toHaveBeenCalled();
    service.disposeAll();
  });

  it("reconnects the current remote workspace through /reconnect", async () => {
    const repo = f.createMemoryRepo(f.baseConfig);
    const legacyTaskService = f.createLegacyTaskService();
    const isConnected = vi.fn(async () => false);
    const ensureConnected = vi.fn(async () => ({ ok: true }));
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "secret-1": "secret" }),
      legacyTaskService,
      remoteWorkspaceService: {
        isConnected,
        ensureConnected,
        getZCodeTaskService: vi.fn(async () => legacyTaskService),
      },
      repo: repo as never,
    });
    await bind(service);

    const replies = await service.handleInboundMessage({
      botId: "webhook-1",
      text: "/reconnect",
      actor,
    });

    expect(replies[0]?.text).toContain("工作区: workspace");
    expect(replies[0]?.text).toContain("状态:");
    expect(ensureConnected).toHaveBeenCalledWith({
      workspacePath: "/tmp/workspace",
      workspaceIdentity: "ssh://host/tmp/workspace",
    });
    expect(legacyTaskService.createTask).not.toHaveBeenCalled();
    service.disposeAll();
  });

  it("sends reconnect callback starting status before reconnect finishes", async () => {
    const repo = f.createMemoryRepo({
      ...f.baseConfig,
      bots: [
        {
          ...f.baseConfig.bots[0]!,
          webhookUrl: "https://example.test/outbound",
        },
      ],
    });
    const legacyTaskService = f.createLegacyTaskService();
    const reconnectDeferred = createDeferred<{ ok: boolean }>();
    const sentTexts: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlText = url instanceof Request ? url.url : String(url);
      if (urlText !== "https://example.test/outbound") {
        return new Response("{}", { status: 200 });
      }
      const body =
        typeof init?.body === "string" ? (JSON.parse(init.body) as { text?: string }) : {};
      sentTexts.push(body.text ?? "");
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "secret-1": "secret" }),
      legacyTaskService,
      remoteWorkspaceService: {
        isConnected: vi.fn(async () => false),
        ensureConnected: vi.fn(() => reconnectDeferred.promise),
        getLegacyTaskService: vi.fn(async () => legacyTaskService),
      },
      repo: repo as never,
    });
    await bind(service);

    const callback = service.handleProviderCallbackResponse("webhook", {
      botId: "webhook-1",
      webhookSecret: "secret",
      text: "/reconnect",
      userId: "user-1",
    });
    await vi.waitFor(() =>
      expect(sentTexts).toEqual(["当前远端项目 /tmp/workspace 未连接，正在为你重连..."]),
    );
    reconnectDeferred.resolve({ ok: true });
    await callback;

    expect(sentTexts).toEqual([
      "当前远端项目 /tmp/workspace 未连接，正在为你重连...",
      expect.stringContaining("工作区: workspace"),
    ]);
    service.disposeAll();
  });

  it("deduplicates repeated /reconnect delivery for the same remote workspace", async () => {
    const repo = f.createMemoryRepo(f.baseConfig);
    const legacyTaskService = f.createLegacyTaskService();
    const reconnectDeferred = createDeferred<{ ok: boolean }>();
    const isConnected = vi.fn(async () => false);
    const ensureConnected = vi.fn(() => reconnectDeferred.promise);
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "secret-1": "secret" }),
      legacyTaskService,
      remoteWorkspaceService: {
        isConnected,
        ensureConnected,
        getLegacyTaskService: vi.fn(async () => legacyTaskService),
      },
      repo: repo as never,
    });
    await bind(service);
    isConnected.mockClear();
    ensureConnected.mockClear();

    const firstReconnect = service.handleInboundMessage({
      botId: "webhook-1",
      text: "/重连",
      actor,
    });
    await vi.waitFor(() => expect(ensureConnected).toHaveBeenCalledTimes(1));

    const duplicateReconnect = service.handleInboundMessage({
      botId: "webhook-1",
      text: "/重连",
      actor,
    });
    reconnectDeferred.resolve({ ok: true });

    await expect(firstReconnect).resolves.toEqual([
      expect.objectContaining({
        text: expect.stringContaining("工作区: workspace"),
      }),
    ]);
    await expect(duplicateReconnect).resolves.toEqual([]);
    const immediateRetry = await service.handleInboundMessage({
      botId: "webhook-1",
      text: "/重连",
      actor,
    });
    expect(immediateRetry).toEqual([]);
    expect(ensureConnected).toHaveBeenCalledTimes(1);
    service.disposeAll();
  });

  it("deduplicates replayed /reconnect provider message ids", async () => {
    const repo = f.createMemoryRepo(f.baseConfig);
    const legacyTaskService = f.createLegacyTaskService();
    const isConnected = vi.fn(async () => false);
    const ensureConnected = vi.fn(async () => ({ ok: true }));
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "secret-1": "secret" }),
      legacyTaskService,
      remoteWorkspaceService: {
        isConnected,
        ensureConnected,
        getLegacyTaskService: vi.fn(async () => legacyTaskService),
      },
      repo: repo as never,
    });
    await bind(service);

    const replayedActor = { ...actor, providerMessageId: "provider-message-1" };
    const firstReplies = await service.handleInboundMessage({
      botId: "webhook-1",
      text: "/重连",
      actor: replayedActor,
    });
    const replayReplies = await service.handleInboundMessage({
      botId: "webhook-1",
      text: "/重连",
      actor: replayedActor,
    });

    expect(firstReplies[0]?.text).toContain("工作区: workspace");
    expect(firstReplies[0]?.text).toContain("状态:");
    expect(replayReplies).toEqual([]);
    expect(ensureConnected).toHaveBeenCalledTimes(1);
    service.disposeAll();
  });

  it("deduplicates replayed provider callbacks before executing messages", async () => {
    const repo = f.createMemoryRepo(f.baseConfig);
    const legacyTaskService = f.createLegacyTaskService();
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "secret-1": "secret" }),
      legacyTaskService,
      remoteWorkspaceService: {
        isConnected: vi.fn(async () => true),
        ensureConnected: vi.fn(async () => ({ ok: true })),
        getZCodeTaskService: vi.fn(async () => legacyTaskService),
        getModelSelectionService: vi.fn(async () =>
          f.createModelSelectionService([{ id: "glm", name: "GLM", models: ["default"] }]),
        ),
      },
      repo: repo as never,
    });
    await bind(service);

    const payload = {
      botId: "webhook-1",
      webhookSecret: "secret",
      messageId: "message-hello-1",
      text: "hello",
      userId: "user-1",
    };
    const first = await service.handleProviderCallbackResponse("webhook", payload);
    const replay = await service.handleProviderCallbackResponse("webhook", payload);

    expect(first.ok).toBe(true);
    expect(first.replies).toEqual([]);
    expect(replay.replies).toEqual([]);
    expect(legacyTaskService.createTask).toHaveBeenCalledTimes(1);
    service.disposeAll();
  });

  it("turns missing session callback failures into a /new task hint", async () => {
    const missingSessionId = "9a18d1e7-24a0-47ba-9747-d3502d8b15b";
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
            activeTaskId: missingSessionId,
            updatedAt: Date.now(),
          },
        },
      },
    );
    const legacyTaskService = f.createLegacyTaskService();
    vi.mocked(legacyTaskService.resumeTask).mockRejectedValueOnce(
      new Error(`Session not found: ${missingSessionId}`),
    );
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "secret-1": "secret" }),
      legacyTaskService,
      repo: repo as never,
    });

    const response = await service.handleProviderCallbackResponse("webhook", {
      botId: "webhook-1",
      webhookSecret: "secret",
      messageId: "message-stale-session-1",
      text: "继续",
      userId: "user-1",
    });

    expect(response).toMatchObject({ ok: false, status: 503 });
    expect(response.replies[0]?.text).toContain("/new task");
    expect(response.replies[0]?.text).not.toContain(missingSessionId);
    expect(response.replies[0]?.text).not.toContain("处理机器人回调失败");
    service.disposeAll();
  });

  it("uses draftOptions when creating a task", async () => {
    const repo = f.createMemoryRepo(f.baseConfig, {
      version: 3,
      bots: {
        "webhook-1": {
          botId: "webhook-1",
          workspacePath: "/tmp/workspace",
          workspaceIdentity: "ssh://host/tmp/workspace",
          workspaceId: "ssh://host/tmp/workspace",
          mode: "draft",
          activeTaskId: null,
          draftOptions: {
            provider: "codex",
            modelSelection: {
              providerId: "glm",
              modelId: "gpt-5.4",
              options: { reasoningLevel: "medium" },
            },
            mode: "plan",
          },
          updatedAt: Date.now(),
        },
      },
    });
    const legacyTaskService = f.createLegacyTaskService();
    vi.mocked(legacyTaskService.getTaskConfigOptions).mockResolvedValue([
      {
        id: "mode",
        category: "mode",
        type: "select",
        currentValue: "default",
        options: [{ value: "yolo", name: "Yolo" }],
      },
      {
        id: "thought_level",
        category: "thought_level",
        type: "select",
        currentValue: "low",
        options: [{ value: "medium", name: "Medium" }],
      },
    ]);
    const zcodeSessionService = f.createZCodeSessionService(
      f.createZCodeSessionSettingsFromConfigOptions([
        {
          id: "mode",
          category: "mode",
          type: "select",
          currentValue: "plan",
          options: [{ value: "plan", name: "Plan" }],
        },
        {
          id: "thought_level",
          category: "thought_level",
          type: "select",
          currentValue: "medium",
          options: [{ value: "medium", name: "Medium" }],
        },
      ]),
    );
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "secret-1": "secret" }),
      legacyTaskService,
      zcodeSessionService,
      repo: repo as never,
    });
    await bind(service);

    await service.handleInboundMessage({
      botId: "webhook-1",
      text: "start",
      actor,
    });

    expect(legacyTaskService.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        modelSelection: {
          providerId: "glm",
          modelId: "gpt-5.4",
          options: { reasoningLevel: "medium" },
        },
      }),
    );
    expect(legacyTaskService.setMode).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "yolo" }),
    );
    expect(legacyTaskService.setConfigOption).not.toHaveBeenCalled();
    service.disposeAll();
  });

  it("validates inherited thought level against the newly selected task model", async () => {
    const repo = f.createMemoryRepo(f.weixinConfig, {
      version: 3,
      bots: {
        "weixin-1": {
          botId: "weixin-1",
          workspacePath: "/tmp/workspace",
          workspaceIdentity: "ssh://host/tmp/workspace",
          workspaceId: "ssh://host/tmp/workspace",
          mode: "draft",
          activeTaskId: null,
          draftOptions: {
            provider: "glm",
            model: "custom:deepseek:deepseek-v4-flash",
            thoughtLevel: "enabled",
          },
          updatedAt: Date.now(),
        },
      },
    });
    const legacyTaskService = f.createLegacyTaskService();
    vi.mocked(legacyTaskService.getTaskConfigOptions).mockResolvedValue([
      {
        id: "mode",
        category: "mode",
        type: "select",
        currentValue: "default",
        options: [{ value: "yolo", name: "Yolo" }],
      },
      {
        id: "thought_level",
        category: "thought_level",
        type: "select",
        currentValue: "max",
        options: [{ value: "max", name: "Max" }],
      },
    ]);
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "weixin-token": "token" }),
      legacyTaskService,
      repo: repo as never,
    });

    const replies = await service.handleInboundMessage({
      botId: "weixin-1",
      text: "hello",
      actor: weixinActor,
    });

    expect(replies).toEqual([]);
    expect(legacyTaskService.setMode).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "yolo" }),
    );
    expect(legacyTaskService.setConfigOption).not.toHaveBeenCalled();
    expect(legacyTaskService.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ v4Create: true }),
    );
    expect(legacyTaskService.sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ content: "hello" }),
    );
    service.disposeAll();
  });

  it("keeps Bot state in draft and deletes the provisional task when initial config fails", async () => {
    const repo = f.createMemoryRepo(f.weixinConfig, {
      version: 3,
      bots: {
        "weixin-1": {
          botId: "weixin-1",
          workspacePath: "/tmp/workspace",
          workspaceIdentity: "ssh://host/tmp/workspace",
          workspaceId: "ssh://host/tmp/workspace",
          mode: "draft",
          activeTaskId: null,
          draftOptions: { provider: "glm" },
          updatedAt: Date.now(),
        },
      },
    });
    const legacyTaskService = f.createLegacyTaskService();
    Object.assign(legacyTaskService, { deleteTask: vi.fn(async () => undefined) });
    vi.mocked(legacyTaskService.getTaskConfigOptions).mockResolvedValue([
      {
        id: "mode",
        category: "mode",
        type: "select",
        currentValue: "default",
        options: [{ value: "yolo", name: "Yolo" }],
      },
    ]);
    vi.mocked(legacyTaskService.setMode).mockRejectedValueOnce(
      new Error("Unsupported reasoning effort: enabled"),
    );
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "weixin-token": "token" }),
      legacyTaskService,
      repo: repo as never,
    });

    await expect(
      service.handleInboundMessage({
        botId: "weixin-1",
        text: "hello",
        actor: weixinActor,
      }),
    ).rejects.toThrow("Unsupported reasoning effort: enabled");

    expect(legacyTaskService.deleteTask).toHaveBeenCalledWith({
      taskId: "task-1",
      workspacePath: "/tmp/workspace",
      workspaceIdentity: "ssh://host/tmp/workspace",
    });
    expect((await repo.readState()).bots["weixin-1"]).toMatchObject({
      mode: "draft",
      activeTaskId: null,
    });
    expect(legacyTaskService.sendPrompt).not.toHaveBeenCalled();
    service.disposeAll();
  });

  it("keeps the active task when /new is requested while the task is running", async () => {
    const repo = f.createMemoryRepo(f.baseConfig);
    const legacyTaskService = f.createLegacyTaskService();
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "secret-1": "secret" }),
      legacyTaskService,
      repo: repo as never,
    });
    await bind(service);
    await service.handleInboundMessage({
      botId: "webhook-1",
      text: "first",
      actor,
    });
    vi.mocked(legacyTaskService.createTask).mockClear();

    const newReplies = await service.handleInboundMessage({
      botId: "webhook-1",
      text: "/new",
      actor,
    });
    await service.handleInboundMessage({
      botId: "webhook-1",
      text: "second",
      actor,
    });

    expect(newReplies[0]?.text).toContain("当前任务正在运行");
    expect(legacyTaskService.createTask).not.toHaveBeenCalled();
    expect((await repo.readState()).bots["webhook-1"]).toMatchObject({
      activeTaskId: "task-1",
      mode: "task",
    });
    service.disposeAll();
  });

  it("blocks context and config selection lists while the current task is running", async () => {
    const repo = f.createMemoryRepo(f.weixinConfig);
    const legacyTaskService = f.createLegacyTaskService();
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "weixin-token": "token" }),
      legacyTaskService,
      repo: repo as never,
    });

    await service.handleInboundMessage({
      botId: "weixin-1",
      text: "first",
      actor: weixinActor,
    });
    await service.handleInboundMessage({
      botId: "weixin-1",
      text: "run task",
      actor: weixinActor,
    });

    for (const text of ["/task", "/workspace", "/model", "/think"]) {
      const replies = await service.handleInboundMessage({
        botId: "weixin-1",
        text,
        actor: weixinActor,
      });
      expect(replies[0]?.text).toContain("当前任务正在运行");
      expect(replies[0]).not.toHaveProperty("selection");
    }
    const modeReplies = await service.handleInboundMessage({
      botId: "weixin-1",
      text: "/mode",
      actor: weixinActor,
    });
    expect(modeReplies[0]?.text).toContain("yolo");
    expect(modeReplies[0]).not.toHaveProperty("selection");
    service.disposeAll();
  });

  it("creates /new draftOptions from the previous active task config", async () => {
    const repo = f.createMemoryRepo(f.weixinConfig, {
      version: 3,
      bots: {
        "weixin-1": {
          botId: "weixin-1",
          workspacePath: "/tmp/workspace",
          workspaceIdentity: "ssh://host/tmp/workspace",
          workspaceId: "ssh://host/tmp/workspace",
          mode: "task",
          activeTaskId: "task-1",
          updatedAt: Date.now(),
        },
      },
    });
    const legacyTaskService = f.createLegacyTaskService();
    vi.mocked(legacyTaskService.listTasks).mockResolvedValue([
      {
        taskId: "task-1",
        title: "Previous task",
        workspacePath: "/tmp/workspace",
        workspaceIdentity: "ssh://host/tmp/workspace",
        provider: "claude",
        model: "fallback-model",
        mode: "fallback-mode",
      },
    ]);
    vi.mocked(legacyTaskService.getTaskConfigOptions).mockResolvedValue([
      {
        id: "model",
        category: "model",
        type: "select",
        currentValue: "claude-sonnet",
        options: [{ value: "claude-sonnet", name: "Claude Sonnet" }],
      },
      {
        id: "mode",
        category: "mode",
        type: "select",
        currentValue: "plan",
        options: [{ value: "plan", name: "Plan" }],
      },
      {
        id: "thoughtLevel",
        category: "thought_level",
        type: "select",
        currentValue: "medium",
        options: [{ value: "medium", name: "Medium" }],
      },
    ]);
    vi.mocked(legacyTaskService.getTaskModelSelection).mockResolvedValue({
      providerId: "glm",
      modelId: "claude-sonnet",
      options: { reasoningLevel: "medium" },
    });
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "weixin-token": "token" }),
      legacyTaskService,
      repo: repo as never,
    });

    const replies = await service.handleInboundMessage({
      botId: "weixin-1",
      text: "/new",
      actor: weixinActor,
    });

    expect(replies[0]?.text).not.toContain("Provider:");
    expect(replies[0]?.text).toContain("任务: 草稿");
    expect((await repo.readState()).bots["weixin-1"]).toMatchObject({
      mode: "draft",
      activeTaskId: null,
      draftOptions: {
        provider: "glm",
        modelSelection: {
          providerId: "glm",
          modelId: "claude-sonnet",
          options: { reasoningLevel: "medium" },
        },
      },
    });

    const statusReplies = await service.handleInboundMessage({
      botId: "weixin-1",
      text: "/status",
      actor: weixinActor,
    });
    expect(statusReplies[0]?.text).not.toContain("Provider:");
    expect(statusReplies[0]?.text).toContain("模型: claude-sonnet");
    expect(statusReplies[0]?.text).toContain("任务: 草稿");
    service.disposeAll();
  });

  it("updates draftOptions through model, mode, think, and cli before creating a task", async () => {
    const repo = f.createMemoryRepo(f.weixinConfig, {
      version: 3,
      bots: {
        "weixin-1": {
          botId: "weixin-1",
          workspacePath: "/tmp/workspace",
          workspaceIdentity: "ssh://host/tmp/workspace",
          workspaceId: "ssh://host/tmp/workspace",
          mode: "draft",
          activeTaskId: null,
          draftOptions: {
            provider: "codex",
            model: "gpt-5.3",
            mode: "default",
            thoughtLevel: "low",
          },
          updatedAt: Date.now(),
        },
      },
    });
    const legacyTaskService = f.createLegacyTaskService();
    vi.mocked(legacyTaskService.getTaskConfigOptions).mockResolvedValue([
      {
        id: "mode",
        category: "mode",
        type: "select",
        currentValue: "default",
        options: [{ value: "yolo", name: "Yolo" }],
      },
      {
        id: "thought_level",
        category: "thought_level",
        type: "select",
        currentValue: "low",
        options: [{ value: "medium", name: "Medium" }],
      },
    ]);
    const zcodeSessionService = f.createZCodeSessionService(
      f.createZCodeSessionSettingsFromConfigOptions([
        {
          id: "model",
          category: "model",
          type: "select",
          currentValue: "gpt-5.3",
          options: [
            { value: "gpt-5.3", name: "GPT-5.3" },
            { value: "gpt-5.4", name: "GPT-5.4" },
          ],
        },
        {
          id: "mode",
          category: "mode",
          type: "select",
          currentValue: "plan",
          options: [{ value: "plan", name: "Plan" }],
        },
        {
          id: "thought_level",
          category: "thought_level",
          type: "select",
          currentValue: "medium",
          options: [{ value: "medium", name: "Medium" }],
        },
      ]),
    );
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "weixin-token": "token" }),
      legacyTaskService,
      zcodeSessionService,
      modelSelectionService: f.createModelSelectionService([
        {
          id: "runtime-provider",
          name: "Runtime Provider",
          endpoints: { baseURL: "https://example.com/v1", paths: { "openai-compatible": "" } },
          defaultKind: "openai-compatible",
          apiKey: "key",
          models: [
            "gpt-5.3",
            {
              id: "gpt-5.4",
              config: {
                optionSpecs: {
                  reasoningLevel: {
                    values: ["low", "medium", "high"],
                  },
                },
              },
            },
          ],
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
      repo: repo as never,
    });

    await service.handleInboundMessage({
      botId: "weixin-1",
      text: "/model",
      actor: weixinActor,
    });
    await service.handleInboundMessage({
      botId: "weixin-1",
      text: "1",
      actor: weixinActor,
    });
    await service.handleInboundMessage({
      botId: "weixin-1",
      text: "2",
      actor: weixinActor,
    });
    expect(
      (await repo.readState()).bots["weixin-1"]?.draftOptions?.modelSelection?.options,
    ).toEqual({ reasoningLevel: "high" });
    await service.handleInboundMessage({
      botId: "weixin-1",
      text: "/mode plan",
      actor: weixinActor,
    });
    await service.handleInboundMessage({
      botId: "weixin-1",
      text: "/think medium",
      actor: weixinActor,
    });
    expect((await repo.readState()).bots["weixin-1"]).toMatchObject({
      draftOptions: {
        provider: "glm",
        modelSelection: {
          providerId: "runtime-provider",
          modelId: "gpt-5.4",
          options: { reasoningLevel: "medium" },
        },
        mode: "default",
      },
    });

    await service.handleInboundMessage({
      botId: "weixin-1",
      text: "start",
      actor: weixinActor,
    });
    expect(legacyTaskService.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "glm",
        modelSelection: {
          providerId: "runtime-provider",
          modelId: "gpt-5.4",
          options: { reasoningLevel: "medium" },
        },
      }),
    );
    expect(legacyTaskService.setMode).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "yolo" }),
    );
    expect(legacyTaskService.setConfigOption).not.toHaveBeenCalled();
    service.disposeAll();
  });

  it("skips stale unsupported draft mode when creating a ZCode Agent task", async () => {
    const repo = f.createMemoryRepo(f.weixinConfig, {
      version: 3,
      bots: {
        "weixin-1": {
          botId: "weixin-1",
          workspacePath: "/tmp/workspace",
          workspaceIdentity: "ssh://host/tmp/workspace",
          workspaceId: "ssh://host/tmp/workspace",
          mode: "draft",
          activeTaskId: null,
          draftOptions: {
            provider: "glm",
            mode: "default",
          },
          updatedAt: Date.now(),
        },
      },
    });
    const legacyTaskService = f.createLegacyTaskService();
    vi.mocked(legacyTaskService.getTaskConfigOptions).mockResolvedValue([
      {
        id: "mode",
        category: "mode",
        type: "select",
        currentValue: "default",
        options: [{ value: "yolo", name: "Yolo" }],
      },
    ]);
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "weixin-token": "token" }),
      legacyTaskService,
      repo: repo as never,
    });

    await service.handleInboundMessage({
      botId: "weixin-1",
      text: "start",
      actor: weixinActor,
    });

    expect(legacyTaskService.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "glm",
      }),
    );
    expect(legacyTaskService.setMode).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "yolo" }),
    );
    service.disposeAll();
  });

  it("blocks task switching while the current task is running", async () => {
    const repo = f.createMemoryRepo(f.weixinConfig);
    const legacyTaskService = f.createLegacyTaskService();
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "weixin-token": "token" }),
      legacyTaskService,
      repo: repo as never,
    });

    await service.handleInboundMessage({
      botId: "weixin-1",
      text: "first",
      actor: weixinActor,
    });
    await service.handleInboundMessage({
      botId: "weixin-1",
      text: "run task",
      actor: weixinActor,
    });
    vi.mocked(legacyTaskService.listTasks).mockResolvedValue([
      {
        taskId: "task-1",
        title: "Running task",
        workspacePath: "/tmp/workspace",
        workspaceIdentity: "ssh://host/tmp/workspace",
      },
      {
        taskId: "task-2",
        title: "Second task",
        workspacePath: "/tmp/workspace",
        workspaceIdentity: "ssh://host/tmp/workspace",
        status: "completed",
      },
    ]);

    await service.handleInboundMessage({
      botId: "weixin-1",
      text: "/task",
      actor: weixinActor,
    });
    const replies = await service.handleInboundMessage({
      botId: "weixin-1",
      text: "2",
      actor: weixinActor,
    });

    expect(replies[0]?.text).toContain("当前任务正在运行");
    expect((await repo.readState()).bots["weixin-1"]).toMatchObject({
      activeTaskId: "task-1",
      mode: "task",
    });
    service.disposeAll();
  });

  it("allows task switching for a legacy active task without persisted status when it is not running", async () => {
    const repo = f.createMemoryRepo(f.weixinConfig, {
      version: 3,
      bots: {
        "weixin-1": {
          botId: "weixin-1",
          workspacePath: "/tmp/workspace",
          workspaceIdentity: "ssh://host/tmp/workspace",
          workspaceId: "ssh://host/tmp/workspace",
          mode: "task",
          activeTaskId: "task-1",
          updatedAt: Date.now(),
        },
      },
    });
    const legacyTaskService = f.createLegacyTaskService();
    vi.mocked(legacyTaskService.listTasks).mockResolvedValue([
      {
        taskId: "task-1",
        title: "Legacy task",
        workspacePath: "/tmp/workspace",
        workspaceIdentity: "ssh://host/tmp/workspace",
      },
      {
        taskId: "task-2",
        title: "Second task",
        workspacePath: "/tmp/workspace",
        workspaceIdentity: "ssh://host/tmp/workspace",
        status: "completed",
      },
    ]);
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "weixin-token": "token" }),
      legacyTaskService,
      repo: repo as never,
    });

    await service.handleInboundMessage({
      botId: "weixin-1",
      text: "/task",
      actor: weixinActor,
    });
    const replies = await service.handleInboundMessage({
      botId: "weixin-1",
      text: "2",
      actor: weixinActor,
    });

    expect(replies[0]?.text).toContain("Second task");
    expect((await repo.readState()).bots["weixin-1"]).toMatchObject({
      activeTaskId: "task-2",
      mode: "task",
    });
    service.disposeAll();
  });

  it("preserves Plan render context after expanding a Feishu custom answer", async () => {
    let messagePostCount = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token" }));
      }
      if (url.includes("/open-apis/im/v1/messages?receive_id_type=") && init?.method === "POST") {
        messagePostCount += 1;
        return new Response(
          JSON.stringify({ code: 0, data: { message_id: `om_plan_${messagePostCount}` } }),
        );
      }
      return new Response(JSON.stringify({ code: 0 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const repo = f.createMemoryRepo(f.feishuConfig, {
      version: 3,
      bots: {
        "feishu-1": {
          botId: "feishu-1",
          workspacePath: "/tmp/workspace",
          workspaceIdentity: "ssh://host/tmp/workspace",
          workspaceId: "ssh://host/tmp/workspace",
          mode: "task",
          activeTaskId: "task-1",
          updatedAt: Date.now(),
        },
      },
    });
    const streamListeners: Array<(event: ZCodeStreamEvent) => Promise<void> | void> = [];
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "feishu-secret": "secret" }),
      legacyTaskService: {
        ...f.createLegacyTaskService(),
        onDynamicTaskEvent: vi.fn(
          () => (listener: (event: ZCodeStreamEvent) => Promise<void> | void) => {
            streamListeners.push(listener);
            return { dispose() {} };
          },
        ),
      },
      repo: repo as never,
    });

    await service.handleInboundMessage({ botId: "feishu-1", text: "启动任务", actor: feishuActor });
    await streamListeners[0]?.({
      type: "elicitation_request",
      taskId: "task-1",
      traceId: "trace-plan",
      requestId: "elicit-plan",
      message: "Review this implementation plan.",
      options: [{ value: "approve", label: "Approve" }],
      schema: {
        interaction: "plan_approval",
        toolName: "ExitPlanMode",
        plan: "# Snake plan\n\n1. Build board\n2. Add controls",
      },
    });
    const sendCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/open-apis/im/v1/messages"),
    );
    const sendBody = JSON.parse(String(sendCall?.[1]?.body)) as { content?: string };
    const token = String(sendBody.content).match(/\/elicitation ([a-f0-9]{12}) __custom__/u)?.[1];

    const response = await service.handleProviderCallbackResponse("feishu", {
      botId: "feishu-1",
      event: {
        operator: { operator_id: { open_id: "ou_user" } },
        action: {
          behaviors: [
            {
              type: "callback",
              value: { command: `/elicitation ${token} __custom__`, zcodeCardText: "Plan" },
            },
          ],
        },
        context: { card_update_token: "plan-card-token" },
      },
    });

    expect(response.ok).toBe(true);
    expect(response.replies[0]?.elicitation?.schema).toMatchObject({
      interaction: "plan_approval",
      plan: expect.stringContaining("# Snake plan"),
    });
    const formSendCall = fetchMock.mock.calls
      .filter(([url]) => String(url).includes("/open-apis/interactive/v1/card/update"))
      .at(-1);
    const formSendBody = JSON.parse(String(formSendCall?.[1]?.body)) as {
      card?: unknown;
    };
    expect(JSON.stringify(formSendBody.card)).toContain("Add controls");
    expect(JSON.stringify(formSendBody.card)).toContain('"tag":"form"');
    expect((await repo.readState()).bots["feishu-1"]?.pendingElicitation?.renderContext).toEqual({
      kind: "plan_approval",
      plan: "# Snake plan\n\n1. Build board\n2. Add controls",
    });
    service.disposeAll();
  });

  it.each([
    {
      name: "Telegram",
      config: f.telegramConfig,
      botId: "telegram-1",
      actor: {
        provider: "telegram" as const,
        botId: "telegram-1",
        providerUserId: "user-1",
        chatType: "private" as const,
      },
      credentials: { "telegram-token": "token" },
      sendPath: "/sendMessage",
      readText: (body: Record<string, unknown>) => String(body.text),
      readOptions: (body: Record<string, unknown>) => JSON.stringify(body.reply_markup),
    },
    {
      name: "Weixin",
      config: f.weixinConfig,
      botId: "weixin-1",
      actor: weixinActor,
      credentials: { "weixin-token": "token" },
      sendPath: "/sendmessage",
      readText: (body: Record<string, unknown>) => {
        const msg = body.msg as {
          item_list?: Array<{ text_item?: { text?: string } }>;
        };
        return String(msg.item_list?.[0]?.text_item?.text);
      },
      readOptions: (body: Record<string, unknown>) => JSON.stringify(body),
    },
  ])(
    "renders complete plan approval text and both actions for $name",
    async ({
      config,
      botId,
      actor: channelActor,
      credentials,
      sendPath,
      readText,
      readOptions,
    }) => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const repo = f.createMemoryRepo(config, {
        version: 3,
        bots: {
          [botId]: {
            botId,
            workspacePath: "/tmp/workspace",
            workspaceIdentity: "ssh://host/tmp/workspace",
            workspaceId: "ssh://host/tmp/workspace",
            mode: "task",
            activeTaskId: "task-1",
            updatedAt: Date.now(),
          },
        },
      });
      const streamListeners: Array<(event: ZCodeStreamEvent) => Promise<void> | void> = [];
      const service = f.createBotsService({
        credentialService: f.createCredentialService(credentials),
        legacyTaskService: {
          ...f.createLegacyTaskService(),
          onDynamicTaskEvent: vi.fn(
            () => (listener: (event: ZCodeStreamEvent) => Promise<void> | void) => {
              streamListeners.push(listener);
              return { dispose() {} };
            },
          ),
        },
        repo: repo as never,
      });
      await service.handleInboundMessage({
        botId,
        text: "start",
        actor: channelActor,
      });
      fetchMock.mockClear();

      await streamListeners[0]?.({
        type: "elicitation_request",
        taskId: "task-1",
        traceId: "trace-plan-text",
        requestId: "elicit-plan-text",
        message: "Review this implementation plan.",
        options: [{ value: "approve", label: "Approve" }],
        schema: {
          interaction: "plan_approval",
          toolName: "ExitPlanMode",
          plan: "# Complete plan\n\n1. Build\n2. Verify",
        },
      });

      const sendCall = fetchMock.mock.calls.find(([url]) => String(url).includes(sendPath));
      const body = JSON.parse(String(sendCall?.[1]?.body)) as Record<string, unknown>;
      const text = readText(body);
      expect(text).toContain("# Complete plan");
      expect(text).toContain("1. Build");
      expect(text).toContain("------");
      expect(text).toContain("请审阅此实施计划。");
      const options = `${text}\n${readOptions(body)}`;
      expect(options).toContain("批准");
      expect(options).toContain("自定义回答");
      service.disposeAll();
    },
  );

  it.each([false, true])(
    "resolves Bot draft intent before first creation without rewriting it on reads (incomplete=%s)",
    async (incomplete) => {
      const original = {
        providerId: "account:bigmodel-individual-coding-plan",
        modelId: "GLM-5.3",
        options: { reasoningLevel: "high" },
      };
      const effective = { ...original, providerId: "account:bigmodel-team-coding-plan" };
      const repo = f.createMemoryRepo(f.weixinConfig, {
        version: 3,
        bots: {
          "weixin-1": {
            botId: "weixin-1",
            workspacePath: "/tmp/workspace",
            workspaceId: "/tmp/workspace",
            mode: "draft",
            activeTaskId: null,
            draftOptions: { provider: "glm", mode: "yolo", modelSelection: original },
            updatedAt: Date.now(),
          },
        },
      });
      const getView = vi.fn(async () => ({
        revision: 1,
        providers: [],
        preferredSelection: { providerId: "unrelated", modelId: "default" },
        effectiveSelection: incomplete ? null : effective,
        ...(incomplete ? { selectionIssue: "model-not-found" } : {}),
      }));
      const taskService = f.createLegacyTaskService();
      const service = f.createBotsService({
        credentialService: f.createCredentialService({ "weixin-token": "token" }),
        modelSelectionService: { getView } as never,
        legacyTaskService: taskService,
        repo: repo as never,
      });
      try {
        await service.handleInboundMessage({
          botId: "weixin-1",
          text: "/status",
          actor: weixinActor,
        });
        expect(getView).toHaveBeenCalledWith({ selection: original });
        expect((await repo.readState()).bots["weixin-1"]?.draftOptions?.modelSelection).toEqual(
          original,
        );
        const sending = service.handleInboundMessage({
          botId: "weixin-1",
          text: "执行这次请求",
          actor: weixinActor,
        });
        if (incomplete) {
          await expect(sending).rejects.toThrow("Submission 模型");
          expect(taskService.createTask).not.toHaveBeenCalled();
          expect((await repo.readState()).bots["weixin-1"]?.draftOptions?.modelSelection).toEqual(
            original,
          );
        } else {
          await sending;
          expect(taskService.createTask).toHaveBeenCalledWith(
            expect.objectContaining({ modelSelection: effective }),
          );
        }
      } finally {
        service.disposeAll();
      }
    },
  );

  it("clears stale providers after a successful empty Model Selection View", async () => {
    const provider = {
      id: "provider-runtime-empty",
      name: "Runtime Provider",
      endpoints: { baseURL: "https://example.com/v1", paths: { "openai-compatible": "" } },
      defaultKind: "openai-compatible" as const,
      apiKey: "key",
      models: ["runtime-model"],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const modelSelectionService = f.createModelSelectionService([provider]);
    const getView = vi.mocked(modelSelectionService.getView);
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "weixin-token": "token" }),
      modelSelectionService,
      repo: f.createMemoryRepo(f.weixinConfig) as never,
    });

    const initial = await service.handleInboundMessage({
      botId: "weixin-1",
      text: "/model",
      actor: weixinActor,
    });
    expect(initial[0]?.text).toContain("Runtime Provider");
    getView.mockResolvedValue({
      revision: 2,
      providers: [],
    });
    const empty = await service.handleInboundMessage({
      botId: "weixin-1",
      text: "/model",
      actor: weixinActor,
    });
    expect(empty[0]?.text).toContain("未找到模型供应商");
    expect(empty[0]?.text).not.toContain("Runtime Provider");
    service.disposeAll();
  });
});
