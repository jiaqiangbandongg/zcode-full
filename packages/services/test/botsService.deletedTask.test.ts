import { afterEach, describe, expect, it, vi } from "vitest";
import type { BotsStateFile } from "@zcode/shared";
import * as f from "./botsService.fixtures.js";

const actor = {
  provider: "webhook" as const,
  botId: "webhook-1",
  providerUserId: "user-1",
  chatType: "private" as const,
};
const services: ReturnType<typeof f.createBotsService>[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.disposeAll();
});

function setup(locale: "zh-CN" | "en-US" = "zh-CN", remote = true) {
  const workspace = {
    workspacePath: "/tmp/workspace",
    ...(remote ? { workspaceIdentity: "ssh://host/tmp/workspace" } : {}),
  };
  const state: BotsStateFile = {
    version: 3,
    bots: {
      "webhook-1": {
        botId: "webhook-1",
        ...workspace,
        workspaceId: workspace.workspaceIdentity ?? workspace.workspacePath,
        mode: "task",
        activeTaskId: "deleted-task",
        updatedAt: Date.now(),
        pendingPermissionOptions: [],
        pendingElicitation: {
          taskId: "deleted-task",
          requestId: "old-question",
          runId: "old-run",
          currentQuestionIndex: 0,
          questions: [
            { question: "旧问题", header: "旧问题", options: [{ value: "yes", label: "是" }] },
          ],
          answers: {},
        },
      },
    },
  };
  const repo = f.createMemoryRepo(
    {
      ...f.baseConfig,
      bots: [
        {
          ...f.baseConfig.bots[0]!,
          providerUserId: "user-1",
          webhookUrl: "https://bot.test/reply",
        },
      ],
    },
    state,
  );
  const taskService = f.createLegacyTaskService();
  vi.mocked(taskService.listDeletedTaskIds).mockResolvedValue(["deleted-task"]);
  const broadcastService = f.createBroadcastService();
  const modelSelectionService = f.createModelSelectionService([
    { id: "glm", name: "GLM", models: ["default"] },
  ]);
  const requests: string[] = [];
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    requests.push(String(init?.body));
    return new Response("{}", { status: 200 });
  });
  vi.stubGlobal("fetch", fetch);
  const service = f.createBotsService({
    repo: repo as never,
    zcodeTaskService: taskService,
    broadcastService,
    modelSelectionService,
    credentialService: f.createCredentialService({ "secret-1": "secret" }),
    settingService: f.createSettingService({
      locale,
      lastWorkspaceSession: [{ kind: remote ? "remote" : "local", ...workspace }],
    }),
    runStartupBackgroundTasks: false,
    warmCandidateCachesOnStartup: false,
  });
  services.push(service);
  return {
    service,
    repo,
    taskService,
    broadcastService,
    modelSelectionService,
    requests,
    fetch,
    workspace,
  };
}
const inbound = { botId: actor.botId, text: "E2E_BOT_DELETED_TASK 原消息", actor };

describe("Bot deleted active task recovery", () => {
  it("replacement reuses the current Selection View and freezes the complete V4 first-send selection", async () => {
    const h = setup();
    const selection = {
      providerId: "account:bigmodel-team-coding-plan",
      modelId: "GLM-5.3",
      options: { reasoningLevel: "high" },
    };
    h.modelSelectionService.getView.mockResolvedValue({
      revision: 2,
      providers: [],
      preferredSelection: selection,
    });
    await h.service.handleInboundMessage(inbound);
    expect(h.taskService.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ v4Create: true, modelSelection: selection }),
    );
    expect(h.taskService.sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ modelSelection: selection, content: inbound.text }),
    );
    expect(h.taskService.getTaskModelSelection).not.toHaveBeenCalled();
    expect((await h.repo.readState()).bots[actor.botId]?.draftOptions).toBeUndefined();
  });

  it("replacement without an available Selection View stays draft without a success notice or default bypass", async () => {
    const h = setup();
    h.modelSelectionService.getView.mockResolvedValue({
      revision: 2,
      providers: [],
      preferredSelection: undefined,
    });
    await expect(h.service.handleInboundMessage(inbound)).rejects.toThrow("Submission");
    expect(h.taskService.createTask).not.toHaveBeenCalled();
    expect(h.taskService.sendPrompt).not.toHaveBeenCalled();
    expect(h.requests).toHaveLength(0);
    expect((await h.repo.readState()).bots[actor.botId]).toMatchObject({
      mode: "draft",
      activeTaskId: null,
    });
  });

  it.each([true, false])(
    "replaces a deleted task once, preserving workspace scope (remote=%s)",
    async (remote) => {
      const h = setup("zh-CN", remote);
      await h.service.handleInboundMessage(inbound);
      expect(h.taskService.listDeletedTaskIds).toHaveBeenCalledWith(h.workspace);
      expect(h.taskService.resumeTask).not.toHaveBeenCalled();
      expect(h.taskService.createTask).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining(h.workspace),
      );
      expect(h.taskService.sendPrompt).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ taskId: "task-1", content: inbound.text }),
      );
      expect((await h.repo.readState()).bots[actor.botId]).toMatchObject({
        activeTaskId: "task-1",
        mode: "task",
        ...h.workspace,
      });
      expect(
        (await h.repo.readState()).bots[actor.botId]?.pendingPermissionOptions,
      ).toBeUndefined();
      expect((await h.repo.readState()).bots[actor.botId]?.pendingElicitation).toBeUndefined();
      expect(h.taskService.respondElicitation).not.toHaveBeenCalled();
      expect(h.requests).toHaveLength(1);
      expect(h.requests[0]).toContain("原任务已删除");
      expect(h.requests[0]).toContain("不会继承原任务的对话上下文");
      expect(h.broadcastService.send).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "bots:task",
          payload: expect.objectContaining({ event: "created", taskId: "task-1", ...h.workspace }),
        }),
      );
      // 后续消息可能因当前运行而被拒绝，但不得重复创建任务或重复发送切换通知。
      await h.service.handleInboundMessage({ ...inbound, text: "第二条消息" });
      expect(h.taskService.createTask).toHaveBeenCalledTimes(1);
      expect(h.requests).toHaveLength(1);
    },
  );

  it("does not infer deletion from a missing filtered task list (including archived/pinned tasks)", async () => {
    const h = setup();
    vi.mocked(h.taskService.listDeletedTaskIds).mockResolvedValue([]);
    delete (await h.repo.readState()).bots[actor.botId]!.pendingElicitation;
    await h.service.handleInboundMessage(inbound);
    expect(h.taskService.createTask).not.toHaveBeenCalled();
    expect(h.taskService.resumeTask).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "deleted-task" }),
    );
    expect(h.requests).toHaveLength(0);
  });

  it("does not replace or dispatch when the authoritative deletion read fails", async () => {
    const h = setup();
    vi.mocked(h.taskService.listDeletedTaskIds).mockRejectedValue(new Error("index unavailable"));
    await expect(h.service.handleInboundMessage(inbound)).rejects.toThrow("index unavailable");
    expect(h.taskService.createTask).not.toHaveBeenCalled();
    expect(h.taskService.sendPrompt).not.toHaveBeenCalled();
    expect((await h.repo.readState()).bots[actor.botId]?.activeTaskId).toBe("deleted-task");
  });

  it("keeps draft state without a success notice if replacement creation fails", async () => {
    const h = setup();
    vi.mocked(h.taskService.createTask).mockRejectedValue(new Error("create failed"));
    await expect(h.service.handleInboundMessage(inbound)).rejects.toThrow("create failed");
    expect((await h.repo.readState()).bots[actor.botId]?.activeTaskId).toBeNull();
    expect(h.requests).toHaveLength(0);
    expect(h.taskService.sendPrompt).not.toHaveBeenCalled();
  });

  it("sends an English transition notice before dispatching the prompt", async () => {
    const h = setup("en-US");
    let noticesAtDispatch = 0;
    vi.mocked(h.taskService.sendPrompt).mockImplementation(async () => {
      noticesAtDispatch = h.requests.length;
    });
    await h.service.handleInboundMessage(inbound);
    expect(h.taskService.sendPrompt).toHaveBeenCalledTimes(1);
    expect(noticesAtDispatch).toBe(1);
    expect(h.requests[0]).toContain("previous task was deleted");
    expect(h.requests[0]).toContain("conversation history");
  });

  it("does not replay the prompt when the transition notice cannot be delivered", async () => {
    const h = setup();
    h.fetch.mockResolvedValue(new Response("unavailable", { status: 400 }));
    const callback = {
      botId: actor.botId,
      userId: actor.providerUserId,
      text: inbound.text,
      messageId: "redelivered-message",
      webhookSecret: "secret",
    };
    await expect(
      h.service.handleProviderCallbackResponse("webhook", callback),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      h.service.handleProviderCallbackResponse("webhook", callback),
    ).resolves.toMatchObject({ ok: true });
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.taskService.createTask).toHaveBeenCalledTimes(1);
    expect(h.taskService.sendPrompt).toHaveBeenCalledTimes(1);
    expect((await h.repo.readState()).bots[actor.botId]?.activeTaskId).toBe("task-1");
  });
});
