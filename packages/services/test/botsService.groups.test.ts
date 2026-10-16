import { TopicHistoryPermissionError } from "../src/bots/topicHistory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BotActor, ZCodeStreamEvent } from "@zcode/shared";
import { botsStateFileSchema } from "@zcode/shared";
import * as f from "./botsService.fixtures.js";

const callbackTransport = vi.hoisted(() => ({
  enabled: false,
  send: vi.fn(async () => ({ providerMessageId: "om_notice" })),
}));
const directoryMock = vi.hoisted(() =>
  vi.fn(async (): Promise<Record<string, string>> => ({ ou_user: "Alice" })),
);
const reactionMock = vi.hoisted(() => vi.fn(async () => {}));
const cardCreateMock = vi.hoisted(() =>
  vi.fn(async () => ({ providerMessageId: "om_interaction" })),
);
const cardUpdateMock = vi.hoisted(() => vi.fn(async () => {}));
const historyMock = vi.hoisted(() =>
  vi.fn(async (_bot: unknown, request: { messageId: string }) => ({
    messages: [],
    checkpoint: request.messageId,
    hasGap: false,
  })),
);

vi.mock("../src/bots/providers/feishuProvider.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/bots/providers/feishuProvider.js")>();
  return {
    ...actual,
    createFeishuBotProvider: (...args: Parameters<typeof actual.createFeishuBotProvider>) => ({
      ...actual.createFeishuBotProvider(...args),
      ...(callbackTransport.enabled
        ? {
            prepareCallbackPayload: async (_bot: unknown, payload: unknown) => payload,
            handleCallbackResponse: undefined,
            resolveActorDisplayName: undefined,
            acknowledgeCallback: vi.fn(async () => undefined),
            send: callbackTransport.send,
          }
        : {}),
      getGroupMemberNames: directoryMock,
      readTopicHistory: historyMock,
      updateInputReaction: reactionMock,
      updateTransientInteractionCard: cardUpdateMock,
      createTransientInteractionCard: cardCreateMock,
      getGroupInfo: vi.fn(async () => ({ name: "测试群" })),
    }),
  };
});

const services: Array<ReturnType<typeof f.createBotsService>> = [];
afterEach(async () => {
  callbackTransport.enabled = false;
  callbackTransport.send.mockClear();
  directoryMock.mockClear();
  reactionMock.mockClear();
  cardUpdateMock.mockClear();
  cardCreateMock.mockClear();
  historyMock.mockClear();
  for (const service of services.splice(0)) await service.disposeAllAndWait();
});

function setup(
  uniqueTaskIds = false,
  modelUnavailable = false,
  remoteConnection?: { connected: boolean },
) {
  const repo = f.createMemoryRepo(structuredClone(f.feishuConfig));
  const taskService = f.createLegacyTaskService();
  if (uniqueTaskIds) {
    // 通用夹具固定返回 task-1，会掩盖跨话题任务校验；隔离用例必须分配不同任务。
    const createTask = taskService.createTask;
    let taskSequence = 0;
    taskService.createTask = vi.fn(async () => ({
      ...(await createTask()),
      taskId: `topic-task-${++taskSequence}`,
    }));
  }
  taskService.invalidateBotTopicInputs = vi.fn(async () => undefined);
  taskService.readBotTopicExecution = vi.fn(async () => undefined);
  taskService.stopBotTopicExecution = vi.fn(async () => undefined);
  taskService.submitBotGroupInput = vi.fn(async (params) => ({
    commandId: params.commandId,
    status: "accepted",
    revisionAtDecision: 1,
    result: { type: "inputAccepted", inputId: params.commandId, delivery: "queue" },
  }));
  const service = f.createBotsService({
    zcodeTaskService: taskService,
    repo: repo as never,
    credentialService: f.createCredentialService({}),
    runStartupBackgroundTasks: false,
    ...(remoteConnection
      ? {
          remoteWorkspaceService: {
            isConnected: vi.fn(async () => remoteConnection.connected),
            ensureConnected: vi.fn(async () => ({ ok: remoteConnection.connected })),
            getZCodeTaskService: vi.fn(async () => taskService),
            getModelSelectionService: vi.fn(async () =>
              f.createModelSelectionService([{ id: "glm", name: "GLM", models: ["default"] }]),
            ),
          },
        }
      : {}),
    ...(modelUnavailable
      ? { modelSelectionService: { getView: vi.fn(async () => null) } as never }
      : {}),
  });
  services.push(service);
  const send = (text: string, chatId = "oc_a", userId = "ou_user", threadId?: string) => {
    const actor: BotActor = {
      provider: "feishu",
      botId: "feishu-1",
      chatType: "group",
      chatId,
      threadId,
      ...(threadId ? { rootMessageId: `root_${threadId}`, topicTitle: threadId } : {}),
      providerUserId: userId,
      providerMessageId: `om_${text}_${userId}`,
    };
    return service.handleInboundMessage({ botId: actor.botId, actor, text });
  };
  return { repo, service, send, taskService };
}

describe("Feishu group sessions", () => {
  it("keeps other recipients as durable background without stopping or admitting work", async () => {
    const { service, send, repo: initialRepo, taskService } = setup();
    let repo = initialRepo;
    await send("/enable");
    await send("start", "oc_a", "ou_user", "omt_roles");
    const before = structuredClone(await repo.readState());
    const message = {
      botId: "feishu-1",
      text: "@Other handle the outline",
      mentionedBot: false,
      botOpenId: "ou_self",
      contentParts: [
        {
          type: "channelMention" as const,
          refId: "other",
          name: "Feishu",
          targetId: "ou_other",
          channel: "feishu" as const,
          idType: "open_id" as const,
          entityType: "unknown" as const,
        },
      ],
      actor: {
        provider: "feishu" as const,
        botId: "feishu-1",
        chatType: "group" as const,
        chatId: "oc_a",
        threadId: "omt_roles",
        rootMessageId: "root_omt_roles",
        providerUserId: "ou_user",
        providerMessageId: "om_other",
      },
    };
    taskService.submitBotGroupInput.mockClear();
    taskService.readBotTopicExecution.mockClear();
    historyMock.mockClear();
    expect(await service.handleInboundMessage(message)).toEqual([]);
    expect(taskService.submitBotGroupInput).not.toHaveBeenCalled();
    expect(taskService.readBotTopicExecution).not.toHaveBeenCalled();
    expect(historyMock).not.toHaveBeenCalled();
    const key = JSON.stringify(["feishu-1", "oc_a", "omt_roles"]);
    const saved = (await repo.readState()).bots[key]!.group!;
    expect(saved.inputs).toEqual(before.bots[key]!.group!.inputs);
    expect(saved.autoReplyGuard).toEqual(before.bots[key]!.group!.autoReplyGuard);
    expect(saved.backgroundHistory?.checkpoint).toBe("om_start_ou_user");
    // 重建 service 和 repo，确认补读边界不依赖内存。
    await service.disposeAllAndWait();
    repo = f.createMemoryRepo(
      structuredClone(f.feishuConfig),
      botsStateFileSchema.parse(JSON.parse(JSON.stringify(await repo.readState()))),
    );
    const restarted = f.createBotsService({
      repo: repo as never,
      zcodeTaskService: taskService,
      credentialService: f.createCredentialService({}),
      runStartupBackgroundTasks: false,
    });
    services.push(restarted);
    await restarted.handleInboundMessage({
      ...message,
      mentionedBot: true,
      actor: { ...message.actor, providerMessageId: "om_both" },
    });
    expect(historyMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ checkpoint: "om_start_ou_user", messageId: "om_both" }),
    );
    expect(taskService.submitBotGroupInput).toHaveBeenCalledTimes(1);
    expect(taskService.submitBotGroupInput.mock.calls[0]![0].source).toMatchObject({
      botIdentity: { name: "Feishu", openId: "ou_self" },
      mentionedBot: true,
    });
    expect((await repo.readState()).bots[key]!.group!.backgroundHistory).toBeUndefined();

    await restarted.handleInboundMessage({
      ...message,
      actor: { ...message.actor, providerMessageId: "om_background_2" },
    });
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    historyMock.mockImplementationOnce(async (_bot, request) => {
      entered();
      await waiting;
      return { messages: [], checkpoint: request.messageId, hasGap: false };
    });
    const accepting = restarted.handleInboundMessage({
      ...message,
      mentionedBot: true,
      actor: { ...message.actor, providerMessageId: "om_accepting" },
    });
    await ready;
    // 补读期间的新背景不能被旧 revision 清除，且保留最早检查点。
    await restarted.handleInboundMessage({
      ...message,
      actor: { ...message.actor, providerMessageId: "om_background_3" },
    });
    release();
    await accepting;
    expect((await repo.readState()).bots[key]!.group!.backgroundHistory?.checkpoint).toBe(
      "om_both",
    );
    await restarted.handleInboundMessage({
      ...message,
      mentionedBot: true,
      actor: { ...message.actor, providerMessageId: "om_final" },
    });
    expect(historyMock).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ checkpoint: "om_both", messageId: "om_final" }),
    );
    expect((await repo.readState()).bots[key]!.group!.backgroundHistory).toBeUndefined();
  });

  it.each([false, true])(
    "keeps empty unmentioned topic output silent (mentioned=%s)",
    async (mentionedBot) => {
      const { service, send, taskService, repo } = setup();
      let emit!: Parameters<ReturnType<typeof taskService.onDynamicTaskEvent>>[0];
      taskService.onDynamicTaskEvent = vi.fn(() => (listener) => {
        emit = listener;
        return { dispose: vi.fn() };
      });
      await send("/enable");
      await send("start", "oc_a", "ou_user", "omt_silent");
      await service.handleInboundMessage({
        botId: "feishu-1",
        mentionedBot,
        text: "follow up",
        botOpenId: "ou_self",
        actor: {
          botId: "feishu-1",
          provider: "feishu",
          chatType: "group",
          chatId: "oc_a",
          threadId: "omt_silent",
          rootMessageId: "root_omt_silent",
          providerUserId: "ou_user",
          providerMessageId: "om_follow",
        },
      });
      const key = JSON.stringify(["feishu-1", "oc_a", "omt_silent"]);
      const context = (await repo.readState()).bots[key]!;
      const inputId = Object.keys(context.group!.inputs!).at(-1)!;
      const base = { taskId: context.activeTaskId!, inputId, traceId: inputId };
      await emit({ ...base, type: "task_run_started", startedAt: 1 });
      await emit({ ...base, type: "task_complete", stopReason: "end_turn" });
      const deliveries = Object.values((await repo.readState()).bots[key]!.group!.deliveries ?? {});
      expect(deliveries).toHaveLength(mentionedBot ? 1 : 0);
      if (mentionedBot) expect(deliveries[0]!.text).toMatch(/任务已完成|Task completed/);
    },
  );

  it.each([undefined, "omt_limit"])(
    "caps bot turns durably and resets only for new humans (%s)",
    async (threadId) => {
      const { service, send, repo: initialRepo, taskService } = setup(true);
      let repo = initialRepo;
      await send("/enable");
      await send("start", "oc_a", "ou_user", threadId);
      const message = (id: string, senderType: "app" | "user" = "app") => ({
        botId: "feishu-1",
        senderType,
        mentionedBot: true,
        text: id,
        actor: {
          botId: "feishu-1",
          provider: "feishu" as const,
          chatType: "group" as const,
          chatId: "oc_a",
          threadId,
          rootMessageId: threadId ? `root_${threadId}` : undefined,
          providerUserId: senderType === "app" ? "ou_other_bot" : "ou_user",
          providerMessageId: id,
        },
      });
      const inputs = async () =>
        Object.values((await repo.readState()).bots)
          .filter((context) => context.group?.threadId === threadId)
          .flatMap((context) => Object.values(context.group?.inputs ?? {}))
          .flatMap(
            (input) =>
              input.source.messages?.map((entry) => entry.messageId) ?? [input.source.messageId],
          );
      await service.handleInboundMessage(message("bot-0"));
      await service.handleInboundMessage(message("bot-0"));
      await Promise.all(
        Array.from({ length: 8 }, (_, i) => service.handleInboundMessage(message(`bot-${i + 1}`))),
      );
      expect((await inputs()).filter((id) => id.startsWith("bot-"))).toHaveLength(5);
      const calls = taskService.submitBotGroupInput.mock.calls.length;
      // 旧真人事件重投不能给自动互答续命。
      await send("start", "oc_a", "ou_user", threadId);
      await service.handleInboundMessage(message("blocked"));
      expect(taskService.submitBotGroupInput).toHaveBeenCalledTimes(calls);
      await service.disposeAllAndWait();
      repo = f.createMemoryRepo(
        structuredClone(f.feishuConfig),
        botsStateFileSchema.parse(JSON.parse(JSON.stringify(await repo.readState()))),
      );
      const restarted = f.createBotsService({
        repo: repo as never,
        zcodeTaskService: taskService,
        credentialService: f.createCredentialService({}),
        runStartupBackgroundTasks: false,
      });
      services.push(restarted);
      await restarted.handleInboundMessage(message("after-restart"));
      expect(taskService.submitBotGroupInput).toHaveBeenCalledTimes(calls);
      await restarted.handleInboundMessage(message("human-new", "user"));
      await restarted.handleInboundMessage(message("bot-resumed"));
      expect(await inputs()).toContain("bot-resumed");
      for (let i = 0; i < 4; i++) await restarted.handleInboundMessage(message(`next-${i}`));
      await restarted.handleInboundMessage(message("human-new", "user"));
      const resumedCalls = taskService.submitBotGroupInput.mock.calls.length;
      await restarted.handleInboundMessage(message("blocked-again"));
      expect(taskService.submitBotGroupInput).toHaveBeenCalledTimes(resumedCalls);
      // 同群另一个话题使用自己的上限。
      await restarted.handleInboundMessage({
        ...message("other-human", "user"),
        actor: {
          ...message("other-human", "user").actor,
          threadId: "omt_other",
          rootMessageId: "root_other",
        },
      });
      await restarted.handleInboundMessage({
        ...message("other-bot"),
        actor: {
          ...message("other-bot").actor,
          threadId: "omt_other",
          rootMessageId: "root_other",
        },
      });
      expect(taskService.submitBotGroupInput).toHaveBeenCalledTimes(resumedCalls + 2);
    },
  );

  it.each(["hello", "/stop", "/reconnect", "/enable"])(
    "admits bot main-chat text %s only when enabled and mentioned, never as control",
    async (text) => {
      const { service, send, taskService } = setup();
      const message = {
        botId: "feishu-1",
        senderType: "app" as const,
        mentionedBot: true,
        text,
        actor: {
          botId: "feishu-1",
          provider: "feishu" as const,
          chatType: "group" as const,
          chatId: "oc_a",
          providerUserId: "ou_other_bot",
          providerMessageId: "om_bot_main",
        },
      };
      expect(await service.handleInboundMessage(message)).toEqual([]);
      await send("/enable");
      expect(await service.handleInboundMessage({ ...message, mentionedBot: false })).toEqual([]);
      expect(taskService.submitBotGroupInput).not.toHaveBeenCalled();
      await service.handleInboundMessage(message);
      expect(taskService.submitBotGroupInput).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["/stop", "/reconnect", "/approve permission allow", "hello"])(
    "admits other-app text %s only in active topics and never as control",
    async (text) => {
      const { service, send, taskService, repo } = setup();
      await send("/enable");
      const message = {
        botId: "feishu-1",
        senderType: "app" as const,
        mentionedBot: true,
        text,
        actor: {
          botId: "feishu-1",
          provider: "feishu" as const,
          chatType: "group" as const,
          chatId: "oc_a",
          threadId: "omt_app",
          rootMessageId: "root_omt_app",
          providerUserId: "ou_other_app",
          providerMessageId: "om_app",
        },
      };
      expect(await service.handleInboundMessage(message)).toEqual([]);
      expect(taskService.submitBotGroupInput).not.toHaveBeenCalled();
      await send("start", "oc_a", "ou_user", "omt_app");
      taskService.submitBotGroupInput.mockClear();
      await service.handleInboundMessage(message);
      expect(taskService.submitBotGroupInput).toHaveBeenCalledTimes(1);
      expect(taskService.submitBotGroupInput.mock.calls[0]?.[0].source).toMatchObject({
        messageId: "om_app",
        senderId: "ou_other_app",
        messages: [expect.objectContaining({ text })],
      });
      await service.handleInboundMessage(message);
      expect(taskService.submitBotGroupInput).toHaveBeenCalledTimes(1);
      await send("/leave", "oc_a", "ou_user", "omt_app");
      expect(
        await service.handleInboundMessage({
          ...message,
          actor: { ...message.actor, providerMessageId: "om_after_leave" },
        }),
      ).toEqual([]);
      expect(taskService.submitBotGroupInput).toHaveBeenCalledTimes(1);
      expect(
        Object.values((await repo.readState()).bots).find(
          (state) => state.group?.threadId === "omt_app",
        )?.group?.topicActive,
      ).toBe(false);
    },
  );

  it("keeps app reconnect text on the provider callback message path", async () => {
    callbackTransport.enabled = true;
    const { service, send, taskService } = setup();
    await send("/enable");
    await send("start", "oc_a", "ou_user", "omt_app");
    taskService.submitBotGroupInput.mockClear();
    const payload = {
      botId: "feishu-1",
      zcodeBotOpenId: "ou_current_bot",
      event: {
        sender: { sender_type: "bot", sender_id: { open_id: "ou_other_bot" } },
        message: {
          chat_type: "group",
          chat_id: "oc_a",
          thread_id: "omt_app",
          root_id: "root_omt_app",
          message_id: "om_app_reconnect",
          message_type: "text",
          content: JSON.stringify({ text: "/reconnect" }),
        },
      },
    };
    await service.handleProviderCallback("feishu", payload);
    await service.handleProviderCallback("feishu", payload);
    expect(taskService.submitBotGroupInput).toHaveBeenCalledTimes(1);
    expect(taskService.submitBotGroupInput.mock.calls[0]?.[0].source.messages?.[0]?.text).toBe(
      "/reconnect",
    );
    payload.event.sender.sender_id.open_id = "ou_current_bot";
    payload.event.message.message_id = "om_self";
    await service.handleProviderCallback("feishu", payload);
    expect(taskService.submitBotGroupInput).toHaveBeenCalledTimes(1);
  });

  it("quotes commands and addresses their sender, not the group owner", async () => {
    const { send } = setup();
    await send("/enable");
    const [reply] = await send("/status", "oc_a", "ou_member");
    expect(reply).toMatchObject({
      providerUserId: "oc_a",
      replyToMessageId: "om_/status_ou_member",
      mentionedUserIds: ["ou_member"],
    });
  });

  it.each([false, true])(
    "topic command only mentions sender when mentionedBot=%s",
    async (mentionedBot) => {
      const { send, service } = setup();
      await send("/enable");
      await send("/status", "oc_a", "ou_member", "omt_reply");
      const [reply] = await service.handleInboundMessage({
        botId: "feishu-1",
        text: "/status",
        mentionedBot,
        topicRootIsCurrentBot: true,
        actor: {
          botId: "feishu-1",
          provider: "feishu",
          chatType: "group",
          chatId: "oc_a",
          threadId: "omt_reply",
          rootMessageId: "root_omt_reply",
          providerUserId: "ou_member",
          providerMessageId: "om_topic_status",
        },
      });
      expect(reply?.replyToMessageId).toBe("om_topic_status");
      expect(reply?.mentionedUserIds).toEqual(mentionedBot ? ["ou_member"] : undefined);
    },
  );

  it("mentions the bound administrator once for owner-only commands in a topic", async () => {
    const { send } = setup();
    await send("/enable");
    const first = await send("/model", "oc_a", "ou_member", "omt_admin");
    expect(first[0]).toMatchObject({ mentionedUserIds: ["ou_user"], callbackToastOnly: true });
    const repeated = await send("/model", "oc_a", "ou_other", "omt_admin");
    expect(repeated[0]?.mentionedUserIds).toEqual([]);
    const otherTopic = await send("/model", "oc_a", "ou_member", "omt_other");
    expect(otherTopic[0]?.mentionedUserIds).toEqual(["ou_user"]);
  });

  it("mentions the administrator when the group has not been enabled", async () => {
    const { send } = setup();
    expect((await send("hello", "oc_a", "ou_member"))[0]?.mentionedUserIds).toEqual(["ou_user"]);
  });

  it("mentions the administrator on model resolution failures without alerting for general failures", async () => {
    const { send, taskService } = setup(false, true);
    await send("/enable");
    const replies = await send("hello", "oc_a", "ou_member", "omt_model");
    expect(replies[0]?.text).toContain("Submission");
    expect(replies[0]?.mentionedUserIds).toEqual(["ou_user"]);
    expect(taskService.submitBotGroupInput).not.toHaveBeenCalled();
    expect((await send("retry", "oc_a", "ou_other", "omt_model"))[0]?.mentionedUserIds).toEqual([]);
  });

  it.each([false, true])(
    "only plan approval mentions the administrator (plan=%s)",
    async (plan) => {
      const { send, taskService } = setup();
      let listener!: (event: ZCodeStreamEvent) => Promise<void>;
      taskService.onDynamicTaskEvent = vi.fn(() => (next: typeof listener) => {
        listener = next;
        return { dispose() {} };
      }) as never;
      await send("/enable");
      await send("start", "oc_a", "ou_member", "omt_question");
      const event = {
        type: "elicitation_request",
        taskId: "task-1",
        traceId: "run-question",
        requestId: "question-1",
        message: "Choose",
        options: [{ value: "approve", label: "Approve" }],
        ...(plan ? { schema: { interaction: "plan_approval", plan: "Build the board" } } : {}),
      } as ZCodeStreamEvent;
      await listener(event);
      const first = cardCreateMock.mock.calls.at(-1) as unknown as [
        unknown,
        { mentionedUserIds?: string[] },
      ];
      expect(first[1].mentionedUserIds).toEqual(plan ? ["ou_user"] : undefined);
      await listener(event);
      expect(cardCreateMock).toHaveBeenCalledTimes(1);
      const updated = cardUpdateMock.mock.calls.at(-1) as unknown as [
        unknown,
        unknown,
        { mentionedUserIds?: string[] },
      ];
      expect(updated[2].mentionedUserIds).toEqual(plan ? [] : undefined);
    },
  );

  it("alerts once while remote workspace is disconnected and re-arms after recovery", async () => {
    const connection = { connected: true };
    const { send } = setup(false, false, connection);
    await send("/enable");
    connection.connected = false;
    expect((await send("hello", "oc_a", "ou_member"))[0]?.mentionedUserIds).toEqual(["ou_user"]);
    expect((await send("again", "oc_a", "ou_other"))[0]?.mentionedUserIds).toEqual([]);
    connection.connected = true;
    await send("start", "oc_a", "ou_member");
    connection.connected = false;
    expect((await send("retry", "oc_a", "ou_member"))[0]?.mentionedUserIds).toEqual(["ou_user"]);
  });

  it("does not notify the administrator for general topic preparation errors", async () => {
    const { send, taskService } = setup();
    await send("/enable");
    taskService.createTask.mockRejectedValueOnce(new Error("General task error"));
    const reply = (await send("hello", "oc_a", "ou_member", "omt_error"))[0];
    expect(reply?.text).toContain("General task error");
    expect(reply?.administratorAttention).not.toBe(true);
    expect(reply?.mentionedUserIds).toBeUndefined();
  });

  it("sends a separate administrator notice for a denied card without modifying the shared card", async () => {
    callbackTransport.enabled = true;
    const { send, service, taskService } = setup();
    let listener!: (event: ZCodeStreamEvent) => Promise<void>;
    taskService.onDynamicTaskEvent = vi.fn(() => (next: typeof listener) => {
      listener = next;
      return { dispose() {} };
    }) as never;
    await send("/enable");
    await send("start", "oc_a", "ou_member");
    const permission = {
      type: "permission_request",
      taskId: "task-1",
      traceId: "run-card",
      requestId: "permission-card",
      description: "Read file",
      kind: "read",
      raw: {},
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once", response: { decision: "allow" } },
      ],
    } as ZCodeStreamEvent;
    await listener(permission);
    const state = (await service.getBotStates()).find((entry) => entry.group?.chatId === "oc_a")!;
    const payload = (eventId: string) => ({
      botId: "feishu-1",
      event_type: "card.action.trigger",
      event_id: eventId,
      operator: { operator_id: { open_id: "ou_member" } },
      action: {
        value: {
          command: "/model",
          groupCard: {
            chatId: "oc_a",
            taskId: state.activeTaskId!,
            authorizationId: state.group!.authorizationId,
          },
        },
      },
      context: { chat_type: "group_chat", open_chat_id: "oc_a", open_message_id: "om_card" },
    });
    await service.handleProviderCallbackResponse("feishu", payload("click-1"));
    expect(callbackTransport.send).toHaveBeenCalledTimes(1);
    expect(callbackTransport.send).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ mentionedUserIds: ["ou_user"], callbackToastOnly: undefined }),
    );
    expect(cardUpdateMock).not.toHaveBeenCalled();
    await service.handleProviderCallbackResponse("feishu", payload("click-2"));
    expect(callbackTransport.send).toHaveBeenCalledTimes(1);
    expect(cardUpdateMock).not.toHaveBeenCalled();
    await listener(permission);
    expect(cardCreateMock).toHaveBeenCalledTimes(1);
    expect(cardUpdateMock).toHaveBeenCalledTimes(1);
  });

  it("automatically joins a verified bot-rooted topic without a mention", async () => {
    const { send, service, taskService } = setup();
    await send("/enable");
    await service.handleInboundMessage({
      botId: "feishu-1",
      text: "continue",
      mentionedBot: false,
      topicRootIsCurrentBot: true,
      actor: {
        botId: "feishu-1",
        provider: "feishu",
        chatType: "group",
        chatId: "oc_a",
        threadId: "bot-root",
        rootMessageId: "root",
        topicTitle: "Bot reply",
        providerUserId: "ou_user",
        providerMessageId: "incoming",
      },
      referencedMessage: { messageId: "root", text: "Bot reply" },
    });
    expect(taskService.createTask).toHaveBeenCalledOnce();
    expect(taskService.submitBotGroupInput).toHaveBeenCalledOnce();
  });

  it("leaves the topic without losing its task and requires a new mention to resume", async () => {
    const { send, service, taskService } = setup();
    await send("/enable");
    await send("start", "oc_a", "ou_user", "omt_active");
    await send("/leave", "oc_a", "ou_user", "omt_active");
    const topic = (await service.getBotStates()).find(
      (state) => state.group?.threadId === "omt_active",
    );
    expect(topic?.group?.topicActive).toBe(false);
    await service.handleInboundMessage({
      botId: "feishu-1",
      text: "ignored",
      mentionedBot: false,
      topicRootIsCurrentBot: true,
      actor: {
        botId: "feishu-1",
        provider: "feishu",
        chatType: "group",
        chatId: "oc_a",
        threadId: "omt_active",
        providerUserId: "ou_user",
        providerMessageId: "ignored",
      },
    });
    expect(taskService.submitBotGroupInput).toHaveBeenCalledOnce();
    await send("resume", "oc_a", "ou_user", "omt_active");
    expect(taskService.createTask).toHaveBeenCalledOnce();
    expect(taskService.submitBotGroupInput).toHaveBeenCalledTimes(2);
    expect(
      (await service.getBotStates()).find((state) => state.group?.threadId === "omt_active")?.group
        ?.topicActive,
    ).toBe(true);
  });

  it.each(["/stop", "/history off", "/disable"])(
    "cancels a pending topic batch when %s arrives during history preparation",
    async (command) => {
      const { send, taskService, service } = setup();
      await send("/enable");
      await send("start", "oc_a", "ou_user", "omt_active");
      await send("/history on");
      let release!: () => void;
      historyMock.mockImplementationOnce(async (bot, request) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { messages: [], checkpoint: request.messageId, hasGap: false };
      });
      reactionMock.mockClear();
      const pending = send("pending", "oc_a", "ou_user", "omt_active");
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      expect((reactionMock.mock.lastCall as unknown[] | undefined)?.[2]).toBe("waiting");
      expect(
        (await service.getBotStates()).find((state) => state.group?.threadId === "omt_active"),
      ).toMatchObject({
        group: { preparation: [expect.objectContaining({ text: "pending", status: "preparing" })] },
      });
      await send(command, "oc_a", "ou_user", "omt_active");
      expect(
        (await service.getBotStates()).find((state) => state.group?.threadId === "omt_active"),
      ).toMatchObject({ group: { preparation: [] } });
      release();
      await pending;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(taskService.submitBotGroupInput).toHaveBeenCalledOnce();
      expect((reactionMock.mock.lastCall as unknown[] | undefined)?.[2]).toBe("cancelled");
    },
  );

  it("cancels history preparation in sibling topics from the group history switch", async () => {
    const { send, taskService } = setup();
    await send("/enable");
    const releases: Array<() => void> = [];
    const prepare: typeof historyMock = vi.fn(async (_bot, request) => {
      await new Promise<void>((resolve) => releases.push(resolve));
      return { messages: [], checkpoint: request.messageId, hasGap: false };
    });
    historyMock.mockImplementationOnce(prepare).mockImplementationOnce(prepare);
    const a = send("first topic", "oc_a", "ou_user", "omt_a");
    const b = send("second topic", "oc_a", "ou_user", "omt_b");
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    await send("/history off");
    releases.forEach((release) => release());
    expect(await Promise.all([a, b])).toEqual([[], []]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(taskService.createTask).not.toHaveBeenCalled();
    expect(taskService.submitBotGroupInput).not.toHaveBeenCalled();
  });

  it("does not submit prepared topic material after service disposal", async () => {
    const { send, service, taskService } = setup();
    await send("/enable");
    let release!: () => void;
    historyMock.mockImplementationOnce(async (_bot, request) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { messages: [], checkpoint: request.messageId, hasGap: false };
    });
    const pending = send("shutdown material", "oc_a", "ou_user", "omt_shutdown");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await service.disposeAllAndWait();
    release();
    expect(await pending).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(taskService.createTask).not.toHaveBeenCalled();
    expect(taskService.submitBotGroupInput).not.toHaveBeenCalled();
  });

  it("cancels topic preparation when the binding user changes", async () => {
    const { send, service, taskService, repo } = setup();
    await send("/enable");
    let release!: () => void;
    historyMock.mockImplementationOnce(async (_bot, request) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { messages: [], checkpoint: request.messageId, hasGap: false };
    });
    const pending = send("binding material", "oc_a", "ou_user", "omt_binding");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const config = await repo.readConfig();
    config.bots[0]!.providerUserId = "new-owner";
    await service.saveConfig(config);
    release();
    expect(await pending).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(taskService.createTask).not.toHaveBeenCalled();
    expect(taskService.submitBotGroupInput).not.toHaveBeenCalled();
  });

  it("retries failed preparation only in its bound task and workspace", async () => {
    const { send, service, repo, taskService } = setup();
    await send("/enable");
    await send("start", "oc_a", "ou_user", "omt_retry");
    await send("/history on");
    historyMock.mockRejectedValueOnce(new Error("temporary history error"));
    await send("retry material", "oc_a", "ou_user", "omt_retry");
    const context = (await service.getBotStates()).find(
      (value) => value.group?.threadId === "omt_retry",
    )!;
    const params = {
      botId: context.botId,
      chatId: "oc_a",
      threadId: "omt_retry",
      taskId: context.activeTaskId!,
      workspacePath: context.workspacePath,
      workspaceIdentity: context.workspaceIdentity,
      messageId: context.group!.preparation![0]!.messageId,
    };
    await expect(
      service.retryTopicPreparation!({ ...params, taskId: "other-task" }),
    ).rejects.toThrow();
    await expect(
      service.retryTopicPreparation!({ ...params, workspaceIdentity: "another-workspace" }),
    ).rejects.toThrow("workspace changed");
    const key = JSON.stringify([params.botId, params.chatId, params.threadId]);
    for (const admission of ["pending", "accepted", "rejected"] as const) {
      const saved = await repo.readState();
      saved.bots[key]!.group!.inputs!.recorded = {
        taskId: params.taskId,
        admission,
        source: {
          ...Object.values(context.group!.inputs!)[0]!.source,
          messageId: params.messageId,
          messages: undefined,
        },
      };
      await repo.writeState(saved);
      await expect(service.retryTopicPreparation!(params)).rejects.toThrow("already submitted");
      expect(
        (await service.getBotStates()).find((value) => value.group?.threadId === params.threadId)!
          .group!.preparation![0]!.status,
      ).toBe("failed");
    }
    const saved = await repo.readState();
    delete saved.bots[key]!.group!.inputs!.recorded;
    await repo.writeState(saved);
    await service.retryTopicPreparation!(params);
    expect(taskService.submitBotGroupInput).toHaveBeenCalledTimes(2);
    expect(
      (await service.getBotStates()).find((value) => value.group?.threadId === "omt_retry")!.group!
        .preparation,
    ).toEqual([]);
    expect(
      Object.values((await repo.readState()).bots).find(
        (value) => value.group?.threadId === "omt_retry",
      )!.group,
    ).not.toHaveProperty("preparation");
  });

  it("does not stop a running topic for an already accepted message", async () => {
    const { send, taskService } = setup();
    await send("/enable");
    await send("start", "oc_a", "ou_user", "omt_active");
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.mocked(taskService.readBotTopicExecution!).mockResolvedValue({ executionId: "running" });
    await send("start", "oc_a", "ou_user", "omt_active");
    expect(taskService.stopBotTopicExecution).not.toHaveBeenCalled();
    expect(taskService.submitBotGroupInput).toHaveBeenCalledOnce();
  });

  it("admits meaningful batch content when its last message is only a native wakeup", async () => {
    const { send, service, taskService } = setup();
    await send("/enable");
    await send("start", "oc_a", "ou_user", "omt_active");
    vi.mocked(taskService.readBotTopicExecution!).mockResolvedValue({ executionId: "old" });
    const started = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    vi.mocked(taskService.stopBotTopicExecution!).mockImplementation(async () => {
      started.resolve();
      await released.promise;
    });
    const actor = {
      provider: "feishu" as const,
      botId: "feishu-1",
      chatType: "group" as const,
      chatId: "oc_a",
      threadId: "omt_active",
      rootMessageId: "root_omt_active",
      providerUserId: "ou_user",
    };
    const first = service.handleInboundMessage({
      botId: "feishu-1",
      actor: { ...actor, providerMessageId: "om_requirement" },
      text: "@Bot analyze logs",
      commandText: "analyze logs",
      mentionedBot: true,
    });
    await started.promise;
    const last = service.handleInboundMessage({
      botId: "feishu-1",
      actor: { ...actor, providerMessageId: "om_wakeup" },
      text: "@Bot",
      commandText: "",
      mentionedBot: true,
    });
    await vi.waitFor(async () =>
      expect(
        (await service.getBotStates()).find((s) => s.group?.threadId === "omt_active")?.group
          ?.preparation?.length,
      ).toBe(2),
    );
    released.resolve();
    await Promise.all([first, last]);
    expect(taskService.submitBotGroupInput).toHaveBeenCalledTimes(2);
    expect(
      vi
        .mocked(taskService.submitBotGroupInput!)
        .mock.calls.at(-1)?.[0]
        .source.messages?.map((m) => m.text),
    ).toEqual(["@Bot analyze logs", "@Bot"]);
  });
  it("stops the old topic run and submits all intervening messages together", async () => {
    const { send, taskService, repo } = setup();
    await send("/enable");
    await send("start", "oc_a", "ou_user", "omt_active");
    const firstCommand = vi.mocked(taskService.submitBotGroupInput!).mock.calls[0]![0].commandId;
    vi.mocked(taskService.readBotTopicExecution!).mockResolvedValue({
      executionId: "old",
      sourceCommandId: firstCommand,
    });
    let finish!: () => void;
    vi.mocked(taskService.stopBotTopicExecution!).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const b = send("second", "oc_a", "ou_user", "omt_active");
    await vi.waitFor(() => expect(taskService.stopBotTopicExecution).toHaveBeenCalledOnce());
    const c = send("third", "oc_a", "ou_user", "omt_active");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(taskService.submitBotGroupInput).toHaveBeenCalledTimes(1);
    finish();
    await Promise.all([b, c]);
    expect(
      (await repo.readState()).bots[JSON.stringify(["feishu-1", "oc_a", "omt_active"])]!.group!
        .inputs![firstCommand]!.progress,
    ).toMatchObject({ status: "stopped", interruptionReason: "newMessage" });
    expect(taskService.submitBotGroupInput).toHaveBeenCalledTimes(2);
    expect(
      vi
        .mocked(taskService.submitBotGroupInput!)
        .mock.calls.at(-1)?.[0]
        .source.messages?.map((m) => m.text),
    ).toEqual(["second", "third"]);
    const originals = vi.mocked(taskService.submitBotGroupInput!).mock.calls.at(-1)![0]
      .source.messages!;
    for (const original of originals) {
      expect(
        reactionMock.mock.calls.some((call) => (call as unknown[])[1] === original.messageId),
      ).toBe(true);
    }
  });

  it("does not reinject a root quote prepared before the previous input was accepted", async () => {
    const { service, send, taskService } = setup();
    await send("/enable");
    const submit = (id: string) =>
      service.handleInboundMessage({
        botId: "feishu-1",
        text: id,
        mentionedBot: true,
        attachments: [
          {
            id: "root-file",
            kind: "file",
            filename: "root.txt",
            mimeType: "text/plain",
            dataBase64: "dGVzdA==",
            providerMetadata: { resourceMessageId: "root" },
          },
          {
            id,
            kind: "file",
            filename: `${id}.txt`,
            mimeType: "text/plain",
            dataBase64: "dGVzdA==",
            providerMetadata: { resourceMessageId: id },
          },
        ],
        referencedMessage: { messageId: "root", text: "shared root" },
        actor: {
          botId: "feishu-1",
          provider: "feishu",
          chatType: "group",
          chatId: "oc_a",
          threadId: "omt_root",
          rootMessageId: "root",
          providerUserId: "ou_user",
          providerMessageId: id,
        },
      });
    await submit("first");
    await submit("second");
    const calls = vi.mocked(taskService.submitBotGroupInput!).mock.calls;
    expect(calls[0]![0].conversationQuotes).toHaveLength(1);
    expect(calls[1]![0].conversationQuotes).toEqual([]);
    expect(calls[0]![0].attachments?.map((item) => item.filename)).toContain("root.txt");
    expect(calls[1]![0].attachments?.map((item) => item.filename)).toEqual(["second.txt"]);
    expect(calls[1]![0].source.messages![0]!.attachmentIndexes).toEqual([0]);
    expect(calls[1]![0].source.messages![0]!.conversationQuotes ?? []).toEqual([]);
  });

  it("keeps consecutive topic replies separate on the same continuous subscription", async () => {
    const { send, taskService, repo } = setup();
    let emit!: Parameters<ReturnType<typeof taskService.onDynamicTaskEvent>>[0];
    taskService.onDynamicTaskEvent = vi.fn(() => (listener) => {
      emit = listener;
      return { dispose: vi.fn() };
    });
    await send("/enable");
    const key = JSON.stringify(["feishu-1", "oc_a", "omt_replies"]);
    const replies = ["这是一张图标图片。", "你好！我在的～"];
    for (const [index, reply] of replies.entries()) {
      await send(`request-${index}`, "oc_a", "ou_user", "omt_replies");
      const context = (await repo.readState()).bots[key]!;
      const inputId = Object.keys(context.group!.inputs!).at(-1)!;
      const base = { taskId: context.activeTaskId!, inputId, traceId: inputId };
      await emit({ ...base, type: "task_run_started", startedAt: index + 1 });
      await emit({ ...base, type: "agent_message_chunk", content: reply });
      await emit({ ...base, type: "task_complete", stopReason: "end_turn" });
      const deliveries = Object.values((await repo.readState()).bots[key]!.group!.deliveries!);
      expect(deliveries.map((item) => item.text)).toEqual(replies.slice(0, index + 1));
      expect(deliveries.at(-1)?.replyToMessageId).toBe(`om_request-${index}_ou_user`);
    }
    expect(taskService.onDynamicTaskEvent).toHaveBeenCalledOnce();
    expect(taskService.onDynamicTaskEvent).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryKind: "bot-channel-continuous" }),
    );
  });

  it("ignores a late terminal event from the previous topic input", async () => {
    const { send, taskService, repo } = setup();
    let emit!: Parameters<ReturnType<typeof taskService.onDynamicTaskEvent>>[0];
    taskService.onDynamicTaskEvent = vi.fn(() => (listener) => {
      emit = listener;
      return { dispose: vi.fn() };
    });
    await send("/enable");
    await send("first", "oc_a", "ou_user", "omt_late");
    await send("second", "oc_a", "ou_user", "omt_late");
    const context = (await repo.readState()).bots[
      JSON.stringify(["feishu-1", "oc_a", "omt_late"])
    ]!;
    const [first, second] = Object.keys(context.group!.inputs!);
    await emit({
      type: "task_run_started",
      taskId: context.activeTaskId!,
      inputId: second,
    } as Parameters<typeof emit>[0]);
    expect(
      (await repo.readState()).bots[JSON.stringify(["feishu-1", "oc_a", "omt_late"])]!.group!
        .inputs![second!]!.progress?.status,
    ).toBe("working");
    reactionMock.mockClear();
    await emit({
      type: "task_complete",
      taskId: context.activeTaskId!,
      inputId: first,
      stopReason: "end_turn",
    } as Parameters<typeof emit>[0]);
    expect(reactionMock).not.toHaveBeenCalled();
  });

  it("ignores unjoined discussion and accepts non-mention messages after topic admission", async () => {
    const { service, send, taskService } = setup();
    await send("/enable");
    const discussion = (text: string) =>
      service.handleInboundMessage({
        botId: "feishu-1",
        text,
        mentionedBot: false,
        actor: {
          botId: "feishu-1",
          provider: "feishu",
          chatType: "group",
          chatId: "oc_a",
          threadId: "omt_active",
          rootMessageId: "root_omt_active",
          providerUserId: "ou_user",
          providerMessageId: `om_${text}`,
        },
      });
    expect(await discussion("before")).toEqual([]);
    expect(taskService.createTask).not.toHaveBeenCalled();
    await send("start", "oc_a", "ou_user", "omt_active");
    await discussion("after");
    expect(taskService.submitBotGroupInput).toHaveBeenCalledTimes(2);
    expect(
      (await service.getBotStates()).find((s) => s.group?.threadId === "omt_active")?.group
        ?.topicActive,
    ).toBe(true);
  });

  it.each(["feishu", "lark"] as const)(
    "includes permission setup links when enabling %s",
    async (provider) => {
      const { repo, service } = setup();
      const config = await repo.readConfig();
      config.bots[0]!.provider = provider;
      await repo.writeConfig(config);
      const enable = () =>
        service.handleInboundMessage({
          botId: "feishu-1",
          text: "/enable",
          actor: {
            botId: "feishu-1",
            provider,
            chatType: "group",
            chatId: "oc_a",
            providerUserId: "ou_user",
          },
        });
      for (let attempt = 0; attempt < 2; attempt++) {
        const replies = await enable();
        expect(replies[0]?.text).toContain(
          provider === "lark" ? "https://open.larksuite.com/app" : "https://open.feishu.cn/app",
        );
        expect(replies[0]?.text).toContain("im:message.group_msg");
        expect(replies[0]?.mentionedUserIds).toBeUndefined();
        expect(replies[0]?.text).toContain("im:chat.members:read");
        expect(replies[0]?.text).toContain("缺少此权限不影响任务执行");
        expect(replies[0]?.text).toContain("发布");
      }
    },
  );

  it("retains topic authorization on transient permission cards", async () => {
    const { send, taskService, service } = setup();
    let listener: ((event: ZCodeStreamEvent) => Promise<void> | void) | undefined;
    taskService.onDynamicTaskEvent = vi.fn(() => (next: typeof listener) => {
      listener = next;
      return { dispose() {} };
    }) as never;
    await send("/enable");
    await send("read attachment", "oc_a", "member", "omt_a");
    await listener!({
      type: "permission_request",
      taskId: "task-1",
      traceId: "run-a",
      requestId: "permission-a",
      description: "Read historical file",
      kind: "read",
      raw: {},
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once", response: { decision: "allow" } },
      ],
    } as ZCodeStreamEvent);
    const topic = (await service.getBotStates()).find(
      (state) => state.group?.threadId === "omt_a",
    )!;
    expect(cardCreateMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        threadId: "omt_a",
        rootMessageId: "root_omt_a",
        mentionedUserIds: ["ou_user"],
        groupTaskId: "task-1",
        groupCard: expect.objectContaining({
          chatId: "oc_a",
          threadId: "omt_a",
          taskId: "task-1",
          authorizationId: topic.group!.authorizationId,
        }),
      }),
    );
  });

  it("guides an empty main-chat mention without admission or reactions", async () => {
    const { send, taskService } = setup();
    await send("/enable");
    const reply = await send("");
    expect(reply[0]?.text).toContain("补充需求");
    expect(taskService.submitBotGroupInput).not.toHaveBeenCalled();
    expect(reactionMock).not.toHaveBeenCalled();
  });

  it("does not execute a bare topic mention without history opt-in", async () => {
    const { send, taskService } = setup();
    await send("/enable");
    expect((await send("", "oc_a", "ou_user", "omt_empty"))[0]?.text).toContain("补充需求");
    expect(taskService.submitBotGroupInput).not.toHaveBeenCalled();
  });

  it("submits explicitly quoted control text as a single ordinary input", async () => {
    const { send, service, taskService } = setup();
    await send("/enable");
    await service.handleInboundMessage({
      botId: "feishu-1",
      text: "",
      referencedMessage: { messageId: "om_question", text: "/stop" },
      actor: {
        botId: "feishu-1",
        provider: "feishu",
        chatType: "group",
        chatId: "oc_a",
        providerUserId: "ou_user",
        providerMessageId: "om_quote_request",
      },
    });
    expect(taskService.submitBotGroupInput).toHaveBeenCalledOnce();
    const submitted = taskService.submitBotGroupInput.mock.calls[0]![0];
    expect(submitted.content).toBe("");
    expect(submitted.conversationQuotes).toEqual([{ messageId: "om_question", text: "/stop" }]);
    expect(submitted.content).not.toContain("[Quoted message]");
    expect(submitted.content).not.toContain("om_question");
  });

  it("keeps quoted text separate from real file and image attachments", async () => {
    const { send, service, taskService } = setup();
    await send("/enable");
    await service.handleInboundMessage({
      botId: "feishu-1",
      text: "inspect these",
      referencedMessage: { messageId: "om_quote_file", text: "original line\nsecond line" },
      attachments: [
        {
          id: "file",
          kind: "file",
          filename: "reference.txt",
          mimeType: "text/plain",
          sizeBytes: 4,
          dataBase64: "dGVzdA==",
        },
        {
          id: "image",
          kind: "image",
          filename: "reference.png",
          mimeType: "image/png",
          sizeBytes: 4,
          dataBase64: "dGVzdA==",
        },
      ],
      actor: {
        botId: "feishu-1",
        provider: "feishu",
        chatType: "group",
        chatId: "oc_a",
        providerUserId: "ou_user",
        providerMessageId: "om_quote_with_materials",
      },
    });
    const admitted = taskService.submitBotGroupInput.mock.calls[0]![0];
    expect(admitted.content).toBe("inspect these");
    expect(admitted.conversationQuotes).toEqual([
      expect.objectContaining({ text: "original line\nsecond line" }),
    ]);
    expect(admitted.attachments).toEqual([
      expect.objectContaining({ kind: "file", filename: "reference.txt", dataBase64: "dGVzdA==" }),
      expect.objectContaining({ kind: "image", filename: "reference.png", dataBase64: "dGVzdA==" }),
    ]);
  });

  it.each([1, 5])(
    "rejects unavailable or excessive group attachments atomically (%s)",
    async (count) => {
      const { send, service, taskService } = setup();
      await send("/enable");
      await service.handleInboundMessage({
        botId: "feishu-1",
        text: "do not execute incomplete input",
        attachments: Array.from({ length: count }, (_, i) => ({
          id: `file-${i}`,
          kind: "file" as const,
          filename: "missing.txt",
          mimeType: "text/plain",
          sizeBytes: 4,
          ...(count > 1 ? { dataBase64: "dGVzdA==" } : {}),
        })),
        actor: {
          botId: "feishu-1",
          provider: "feishu",
          chatType: "group",
          chatId: "oc_a",
          providerUserId: "ou_user",
          providerMessageId: `om_missing_${count}`,
        },
      });
      expect(taskService.submitBotGroupInput).not.toHaveBeenCalled();
      expect(taskService.createTask).not.toHaveBeenCalled();
    },
  );

  it("rejects oversized explicit quotations before creating or admitting a task", async () => {
    const { send, service, taskService } = setup();
    await send("/enable");
    const replies = await service.handleInboundMessage({
      botId: "feishu-1",
      text: "summarize",
      referencedMessage: { messageId: "om_large_quote", text: "a".repeat(8001) },
      actor: {
        botId: "feishu-1",
        provider: "feishu",
        chatType: "group",
        chatId: "oc_a",
        providerUserId: "ou_user",
        providerMessageId: "om_large_request",
      },
    });
    expect(replies.length).toBeGreaterThan(0);
    expect(taskService.createTask).not.toHaveBeenCalled();
    expect(taskService.submitBotGroupInput).not.toHaveBeenCalled();
  });

  it("blocks explicitly disabled history before task creation", async () => {
    const { send, taskService } = setup();
    await send("/enable");
    await send("/history off");
    const replies = await send("hello", "oc_a", "ou_user", "omt_off");
    expect(historyMock).not.toHaveBeenCalled();
    expect(taskService.createTask).not.toHaveBeenCalled();
    expect(taskService.submitBotGroupInput).not.toHaveBeenCalled();
    expect(replies[0]?.text).toContain("/history on");
    expect(replies[0]?.mentionedUserIds).toEqual(["ou_user"]);
  });

  it("guides the administrator without admission on missing history permission", async () => {
    const { send, taskService } = setup();
    await send("/enable");
    historyMock.mockRejectedValueOnce(new TopicHistoryPermissionError("Access denied"));
    const replies = await send("hello", "oc_a", "ou_user", "omt_permission");
    expect(replies[0]?.text).toContain("im:message.group_msg");
    expect(replies[0]?.text).toContain("https://open.feishu.cn/app");
    expect(taskService.createTask).not.toHaveBeenCalled();
    expect(taskService.submitBotGroupInput).not.toHaveBeenCalled();
    await send("retry", "oc_a", "ou_user", "omt_permission");
    expect(taskService.submitBotGroupInput).toHaveBeenCalledOnce();
  });

  it("reads topic history by default and blocks a failed read before task creation", async () => {
    const { send, taskService } = setup();
    await send("/enable");
    historyMock.mockRejectedValueOnce(new Error("network unavailable"));
    const replies = await send("hello", "oc_a", "ou_user", "omt_error");
    expect(historyMock).toHaveBeenCalledOnce();
    expect(taskService.createTask).not.toHaveBeenCalled();
    expect(taskService.submitBotGroupInput).not.toHaveBeenCalled();
    expect(replies[0]?.text).toMatch(/retry|重试/);
    expect((reactionMock.mock.lastCall as unknown[] | undefined)?.[2]).toBe("failed");
  });

  it("uses available opted-in topic discussion for a bare mention", async () => {
    const { send, taskService } = setup();
    await send("/enable");
    await send("/history on");
    historyMock.mockResolvedValueOnce({
      messages: [
        {
          id: "om_background",
          chatId: "oc_a",
          threadId: "omt_empty",
          senderId: "ou_user",
          senderType: "user",
          text: "What is two plus two",
          createdAt: 1,
          kind: "text",
        },
      ] as never[],
      checkpoint: "om__ou_user",
      hasGap: false,
    });
    await send("", "oc_a", "ou_user", "omt_empty");
    const input = taskService.submitBotGroupInput.mock.calls[0]![0];
    expect(input.content).toBe("");
    expect(input.attachments).toEqual([
      expect.objectContaining({
        kind: "file",
        sourceKind: "topic-history",
        mimeType: "text/plain",
        textContent: expect.stringContaining("What is two plus two"),
      }),
    ]);
    expect(input.attachments[0].textContent).toContain("ou_user");
    expect(input.content).not.toContain("What is two plus two");
    expect(input.source.topicContext).toBeUndefined();
    expect(JSON.stringify(input.source)).not.toContain("What is two plus two");

    expect(taskService.submitBotGroupInput).toHaveBeenCalledOnce();
    expect(taskService.submitBotGroupInput).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({
          topicHistory: expect.objectContaining({ checkpoint: "om__ou_user", messageCount: 1 }),
        }),
      }),
    );
  });

  it("rejects a bare mention when opted-in history is unavailable", async () => {
    const { send, taskService } = setup();
    await send("/enable");
    await send("/history on");
    historyMock.mockRejectedValueOnce(new Error("history unavailable"));
    expect((await send("", "oc_a", "ou_user", "omt_empty"))[0]?.text).toContain("重试");
    expect(taskService.submitBotGroupInput).not.toHaveBeenCalled();
  });

  it("keeps the last successful checkpoint when a history read is rejected", async () => {
    const { send, taskService } = setup();
    await send("/enable");
    await send("/history on");
    historyMock.mockResolvedValueOnce({
      messages: [],
      checkpoint: "om_first_ou_user",
      hasGap: false,
    });
    await send("first", "oc_a", "ou_user", "omt_gap");
    await send("/history on");
    historyMock.mockRejectedValueOnce(new Error("history unavailable"));
    await send("second", "oc_a", "ou_user", "omt_gap");
    expect(taskService.submitBotGroupInput).toHaveBeenCalledOnce();
    await send("third", "oc_a", "ou_user", "omt_gap");
    expect(historyMock.mock.calls.at(-1)?.[1].checkpoint).toBe("om_first_ou_user");
  });

  it("preserves a history opt-in while an earlier input admission finishes", async () => {
    const { send, repo, taskService } = setup();
    await send("/enable");
    const original = taskService.submitBotGroupInput!;
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    taskService.submitBotGroupInput = vi.fn(async (params) => {
      started();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return original(params);
    });
    const pending = send("work");
    await ready;
    await send("/history on", "oc_a", "ou_user", "omt_settings");
    release();
    await pending;
    expect(
      (await repo.readState()).bots[JSON.stringify(["feishu-1", "oc_a"])]?.group?.historyEnabled,
    ).toBe(true);
  });

  it("rejects admission if the group is disabled during topic history preparation", async () => {
    const { send, taskService } = setup();
    await send("/enable");
    await send("/history on");
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    historyMock.mockImplementationOnce(async (_bot, request) => {
      started();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { messages: [], checkpoint: request.messageId, hasGap: false };
    });
    const pending = send("pending history", "oc_a", "ou_user", "omt_race");
    await ready;
    await send("/disable");
    release();
    expect(await pending).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(taskService.createTask).not.toHaveBeenCalled();
    expect(taskService.submitBotGroupInput).not.toHaveBeenCalled();
  });

  it("scopes topic details to the bound task and workspace", async () => {
    const { send, service, repo, taskService } = setup();
    await send("/enable");
    await send("topic request", "oc_a", "ou_user", "thread-a");
    const state = (await repo.readState()).bots[JSON.stringify(["feishu-1", "oc_a", "thread-a"])]!;
    taskService.readBotTopicSummaries = vi.fn(async () => [
      { checkpoint: "m1", text: "Decision: blue" },
    ]);
    const params = {
      botId: "feishu-1",
      chatId: "oc_a",
      threadId: "thread-a",
      taskId: state.activeTaskId!,
      workspacePath: state.workspacePath!,
      workspaceIdentity: state.workspaceIdentity,
    };
    expect(await service.getTopicDetails!(params)).toMatchObject({
      summaries: [{ checkpoint: "m1", text: "Decision: blue" }],
      messageCount: 0,
    });
    await expect(service.getTopicDetails!({ ...params, taskId: "unrelated" })).rejects.toThrow(
      /scope/,
    );
    await expect(
      service.getTopicDetails!({ ...params, workspaceIdentity: "ssh://other" }),
    ).rejects.toThrow(/scope/);
  });

  it.each([false, true])(
    "isolates reply topics and migrates old aliases once (legacy=%s)",
    async (legacy) => {
      const { send, repo, taskService } = setup(true);
      taskService.getBotGroupTaskBlockReason = vi.fn(async () => null);
      taskService.renameTask = vi.fn(async () => ({ taskId: "topic-task-1" }) as never);
      await send("/enable");
      const state = await repo.readState();
      const key = JSON.stringify(["feishu-1", "oc_a"]);
      state.bots[key]!.activeTaskId = "original-task";
      state.bots[key]!.mode = "task";
      state.bots[key]!.group!.taskIds = ["original-task"];
      state.bots[key]!.group!.deliveries = {
        result: {
          id: "result",
          taskId: "original-task",
          text: "reply",
          status: "sent",
          updatedAt: 1,
          providerMessageId: "root_omt_reply",
        },
      };
      await repo.writeState(state);
      if (legacy) {
        state.bots[key]!.group!.topicAliases = {
          omt_reply: { taskId: "original-task", rootMessageId: "root_omt_reply" },
        };
        state.bots[key]!.group!.taskWorkspaces = {
          "original-task": { workspacePath: "/old-workspace", workspaceIdentity: "old-identity" },
        };
        await repo.writeState(state);
      }
      await send("first reply", "oc_a", "ou_user", "omt_reply");
      await send("second reply", "oc_a", "ou_user", "omt_reply");
      const after = await repo.readState();
      const topic = after.bots[JSON.stringify(["feishu-1", "oc_a", "omt_reply"])];
      expect(topic?.activeTaskId).toBe("topic-task-1");
      expect(taskService.createTask).toHaveBeenCalledOnce();
      if (legacy)
        expect(taskService.getBotGroupTaskBlockReason).toHaveBeenCalledWith({
          taskId: "original-task",
          workspacePath: "/old-workspace",
          workspaceIdentity: "old-identity",
        });
      expect(after.bots[key]?.group?.topicAliases?.omt_reply).toBeUndefined();
      expect(taskService.renameTask).toHaveBeenCalledWith(
        expect.objectContaining({ title: "飞书 · 测试群 · omt_reply" }),
      );
      expect(taskService.submitBotGroupInput.mock.calls.map(([input]) => input.taskId)).toEqual([
        "topic-task-1",
        "topic-task-1",
      ]);
      expect(after.bots[key]?.activeTaskId).toBe("original-task");
      const [reply] = await send("/new", "oc_a", "ou_user", "omt_reply");
      expect(reply.text).toMatch(/another topic|另开/);
    },
  );
  it("reads history only on entry or explicit reconciliation and keeps the accepted checkpoint", async () => {
    const { send, taskService } = setup();
    await send("/enable");
    await send("first", "oc_a", "ou_user", "omt_a");
    expect(historyMock).toHaveBeenCalledOnce();
    await send("/history on");
    await send("second", "oc_a", "ou_user", "omt_a");
    expect(historyMock).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        messageId: "om_second_ou_user",
        checkpoint: "om_first_ou_user",
      }),
    );
    await send("third", "oc_a", "ou_user", "omt_a");
    expect(historyMock).toHaveBeenCalledTimes(2);
    expect(
      taskService.submitBotGroupInput.mock.calls.at(-1)?.[0].source.topicHistory,
    ).toBeUndefined();
    await send("/leave", "oc_a", "ou_user", "omt_a");
    await send("resume", "oc_a", "ou_user", "omt_a");
    expect(historyMock).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ checkpoint: "om_third_ou_user" }),
    );
  });
  it("keeps history off until the owner explicitly enables it for the group", async () => {
    const { send, repo } = setup();
    await send("/enable");
    const key = JSON.stringify(["feishu-1", "oc_a"]);
    expect((await repo.readState()).bots[key]?.group?.historyEnabled).toBeFalsy();
    await send("/history on", "oc_a", "member");
    expect((await repo.readState()).bots[key]?.group?.historyEnabled).toBeFalsy();
    await send("/history on", "oc_a", "ou_user", "omt_a");
    expect((await repo.readState()).bots[key]?.group?.historyEnabled).toBe(true);
    await send("/history off");
    expect((await repo.readState()).bots[key]?.group?.historyEnabled).toBe(false);
  });
  it("carries topic identity through admission without a legacy queue card", async () => {
    const { send, taskService, repo } = setup();
    await send("/enable");
    const [reply] = await send("topic request", "oc_a", "ou_user", "omt_a");
    expect(taskService.submitBotGroupInput).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({
          threadId: "omt_a",
          authorizationId: (await repo.readState()).bots[JSON.stringify(["feishu-1", "oc_a"])]!
            .group!.authorizationId,
        }),
      }),
    );
    expect(reply).toBeUndefined();
    const [newReply] = await send("/new", "oc_a", "ou_user", "omt_a");
    expect(newReply.text).toMatch(/another topic|另开/);
  });
  it("creates independent topic drafts from group defaults and keeps the default draft", async () => {
    const { send, repo } = setup();
    await send("/enable");
    await send("/status", "oc_a", "ou_user", "omt_a");
    await send("/status", "oc_a", "ou_user", "omt_b");
    const { bots } = await repo.readState();
    const a = bots[JSON.stringify(["feishu-1", "oc_a", "omt_a"])];
    const b = bots[JSON.stringify(["feishu-1", "oc_a", "omt_b"])];
    expect(a?.group?.threadId).toBe("omt_a");
    expect(b?.group?.threadId).toBe("omt_b");
    expect(a?.draftOptions?.mode).toBe("default");
    expect(a?.group?.inputs).toBeUndefined();
    expect(bots[JSON.stringify(["feishu-1", "oc_a"])].group?.threadId).toBeUndefined();
  });

  it("disables the entire group from a topic and invalidates sibling authorization", async () => {
    const { send, repo } = setup();
    await send("/enable");
    await send("/status", "oc_a", "ou_user", "omt_a");
    await send("/status", "oc_a", "ou_user", "omt_b");
    await send("/disable", "oc_a", "ou_user", "omt_a");
    const groups = Object.values((await repo.readState()).bots).filter((s) => s.group);
    expect(groups).toHaveLength(3);
    expect(groups.every((s) => s.group?.enabled === false)).toBe(true);
    const [reply] = await send("/status", "oc_a", "member", "omt_b");
    expect(reply?.text).toMatch(/not enabled|未启用/i);
  });
  it.each([undefined, "omt_fast"])(
    "keeps completed progress and reaction before admission returns (%s)",
    async (threadId) => {
      const { send, taskService, repo } = setup();
      let emit!: Parameters<ReturnType<typeof taskService.onDynamicTaskEvent>>[0];
      taskService.onDynamicTaskEvent = vi.fn(() => (listener) => {
        emit = listener;
        return { dispose: vi.fn() };
      });
      taskService.submitBotGroupInput = vi.fn(async (params) => {
        await emit({
          type: "task_run_started",
          taskId: params.taskId,
          inputId: params.commandId,
        } as Parameters<typeof emit>[0]);
        await emit({
          type: "task_complete",
          taskId: params.taskId,
          inputId: params.commandId,
          stopReason: "end_turn",
        } as Parameters<typeof emit>[0]);
        return {
          commandId: params.commandId,
          status: "accepted",
          revisionAtDecision: 1,
          result: { type: "inputAccepted", inputId: params.commandId, delivery: "queue" },
        };
      });
      await send("/enable");
      await send("fast completion", "oc_a", "ou_user", threadId);
      const context = Object.values((await repo.readState()).bots).find(
        (value) => value.group?.inputs,
      )!;
      const input = Object.values(context.group!.inputs!)[0]!;
      expect(input.admission).toBe("accepted");
      expect(input.progress?.status).toBe("done");
      expect((reactionMock.mock.lastCall as unknown[] | undefined)?.[2]).toBe("done");
    },
  );
  it.each(["task_complete", "task_error"] as const)(
    "projects %s onto the original input reaction",
    async (type) => {
      const { send, taskService, repo } = setup();
      let emit!: Parameters<ReturnType<typeof taskService.onDynamicTaskEvent>>[0];
      taskService.onDynamicTaskEvent = vi.fn(() => (listener) => {
        emit = listener;
        return { dispose: vi.fn() };
      });
      await send("/enable");
      await send("reaction result", "oc_a", "ou_member");
      const context = Object.values((await repo.readState()).bots).find((value) => value.group)!;
      const [inputId, input] = Object.entries(context.group!.inputs!)[0]!;
      const saved = await repo.readState();
      const savedContext = Object.values(saved.bots).find((value) => value.group)!;
      savedContext.group!.inputs![inputId]!.progress = {
        status: "waiting",
        cardMessageId: "om_queue_card",
        cardStatus: "waiting",
      };
      await repo.writeState(saved);
      await emit({ type: "task_run_started", taskId: context.activeTaskId!, inputId } as Parameters<
        typeof emit
      >[0]);
      await emit({
        type,
        taskId: context.activeTaskId!,
        inputId,
        stopReason: "end_turn",
        error: "test failure",
      } as Parameters<typeof emit>[0]);
      const last = reactionMock.mock.lastCall as unknown[] | undefined;
      expect(last?.[1]).toBe(input.source.messageId);
      expect(last?.[2]).toBe(type === "task_error" ? "failed" : "done");
      const cardCalls = cardUpdateMock.mock.calls as unknown as Array<
        [unknown, { providerMessageId: string }, { text: string; selection?: unknown }]
      >;
      expect(cardCalls.map((call) => call[1].providerMessageId)).toEqual([
        "om_queue_card",
        "om_queue_card",
      ]);
      expect(cardCalls.map((call) => call[2].text)).toEqual([
        "正在执行",
        type === "task_error" ? "执行失败" : "已完成",
      ]);
      expect(cardCalls.every((call) => call[2].selection === undefined)).toBe(true);
    },
  );
  it.each(["task_complete", "turn_steer_status"])(
    "does not send old topic queue or stop notices for %s",
    async (type) => {
      const { send, taskService, repo } = setup();
      let emit!: Parameters<ReturnType<typeof taskService.onDynamicTaskEvent>>[0];
      taskService.onDynamicTaskEvent = vi.fn(() => (listener) => {
        emit = listener;
        return { dispose: vi.fn() };
      });
      await send("/enable");
      await send("topic input", "oc_a", "ou_user", "omt_notices");
      const key = JSON.stringify(["feishu-1", "oc_a", "omt_notices"]);
      const context = (await repo.readState()).bots[key]!;
      const inputId = Object.keys(context.group!.inputs!)[0]!;
      await emit({ type: "task_run_started", taskId: context.activeTaskId!, inputId } as Parameters<
        typeof emit
      >[0]);
      await emit({
        type,
        taskId: context.activeTaskId!,
        inputId,
        stopReason: "cancelled",
        status: "discarded",
        reason: "session_resumed",
        pendingInputIds: [inputId],
      } as Parameters<typeof emit>[0]);
      expect(Object.values((await repo.readState()).bots[key]!.group!.deliveries ?? {})).toEqual(
        [],
      );
      expect((reactionMock.mock.calls.at(-1) as unknown[] | undefined)?.[2]).toBe("cancelled");
      expect((await repo.readState()).bots[key]!.group!.inputs![inputId]!.progress?.status).toBe(
        type === "task_complete" ? "stopped" : "discarded",
      );
    },
  );

  it.each(["Alice", "ou_member"])(
    "keeps stopped group runs silent while updating reactions (%s)",
    async (senderName) => {
      const { send, taskService, repo } = setup();
      let emit!: Parameters<ReturnType<typeof taskService.onDynamicTaskEvent>>[0];
      taskService.onDynamicTaskEvent = vi.fn(() => (listener) => {
        emit = listener;
        return { dispose: vi.fn() };
      });
      await send("/enable");
      await send("hello", "oc_a", "ou_member");
      const state = await repo.readState();
      const context = Object.values(state.bots).find((value) => value.group)!;
      const [inputId, input] = Object.entries(context.group!.inputs!)[0]!;
      input.source.senderName = senderName;
      await repo.writeState(state);
      await emit({ type: "task_run_started", taskId: context.activeTaskId!, inputId } as Parameters<
        typeof emit
      >[0]);
      await emit({
        type: "task_complete",
        taskId: context.activeTaskId!,
        inputId,
        stopReason: "cancelled",
      } as Parameters<typeof emit>[0]);
      const updated = Object.values((await repo.readState()).bots).find((value) => value.group)!;
      expect(Object.values(updated.group!.deliveries ?? {})).toEqual([]);
      expect(reactionMock.mock.calls.map((call) => (call as unknown[])[2])).toEqual([
        "waiting",
        "working",
        "cancelled",
      ]);
    },
  );

  it("keeps each run's reply target when another member speaks and clears it for desktop runs", async () => {
    const { send, taskService, repo } = setup();
    let emit!: Parameters<ReturnType<typeof taskService.onDynamicTaskEvent>>[0];
    taskService.onDynamicTaskEvent = vi.fn(() => (listener) => {
      emit = listener;
      return { dispose: vi.fn() };
    });
    await send("/enable");
    await send("first", "oc_a", "ou_alice");
    await send("second", "oc_a", "ou_bob");
    const context = Object.values((await repo.readState()).bots).find((value) => value.group)!;
    const inputs = Object.entries(context.group!.inputs!);
    expect(inputs).toHaveLength(2);
    for (const [inputId] of [...inputs, ["desktop-run", undefined]]) {
      await emit({ type: "task_run_started", taskId: context.activeTaskId!, inputId } as Parameters<
        typeof emit
      >[0]);
      await emit({
        type: "task_complete",
        taskId: context.activeTaskId!,
        inputId,
        stopReason: "error",
        error: "example failure",
      } as Parameters<typeof emit>[0]);
    }
    const updated = Object.values((await repo.readState()).bots).find((value) => value.group)!;
    const results = Object.values(updated.group!.deliveries!);
    expect(results).toHaveLength(3);
    for (const [index, [, input]] of inputs.entries()) {
      expect(results[index]).toMatchObject({
        replyToMessageId: input.source.messageId,
        mentionedUserIds: [input.source.senderId],
      });
    }
    expect(results[2]?.replyToMessageId).toBeUndefined();
    expect(results[2]?.mentionedUserIds).toBeUndefined();
  });

  it("quotes the batch boundary and mentions deduplicated participants only on the first saved part", async () => {
    const { send, taskService, repo } = setup();
    let emit!: Parameters<ReturnType<typeof taskService.onDynamicTaskEvent>>[0];
    taskService.onDynamicTaskEvent = vi.fn(() => (listener) => {
      emit = listener;
      return { dispose: vi.fn() };
    });
    await send("/enable");
    await send("batch", "oc_a", "ou_bob", "omt_batch");
    const state = await repo.readState();
    const context = Object.values(state.bots).find(
      (value) => value.group?.threadId === "omt_batch",
    )!;
    const [inputId, input] = Object.entries(context.group!.inputs!)[0]!;
    input.source.messages = [
      {
        messageId: "om_first",
        senderId: "ou_alice",
        senderName: "Alice",
        mentionedBot: true,
        text: "first",
        attachmentIndexes: [],
      },
      {
        messageId: "om_next",
        senderId: "ou_alice",
        senderName: "Alice",
        text: "next",
        attachmentIndexes: [],
      },
      {
        messageId: input.source.messageId,
        senderId: "ou_bob",
        senderName: "Bob",
        text: "last",
        attachmentIndexes: [],
      },
    ];
    await repo.writeState(state);
    await emit({ type: "task_run_started", taskId: context.activeTaskId!, inputId } as Parameters<
      typeof emit
    >[0]);
    await emit({
      type: "task_error",
      taskId: context.activeTaskId!,
      inputId,
      error: "错误详情".repeat(1100),
    } as Parameters<typeof emit>[0]);
    const updated = Object.values((await repo.readState()).bots).find(
      (value) => value.group?.threadId === "omt_batch",
    )!;
    const results = Object.values(updated.group!.deliveries!);
    expect(results.length).toBeGreaterThan(1);
    for (const [index, result] of results.entries()) {
      expect(result.replyToMessageId).toBe(input.source.messageId);
      expect(result.threadId).toBe("omt_batch");
      expect(result.mentionedUserIds).toEqual(index === 0 ? ["ou_alice"] : undefined);
    }
  });

  it("reads names only for an enabled authorized group", async () => {
    const { send, service } = setup();
    const params = { botId: "feishu-1", chatId: "oc_a" };
    await expect(service.getGroupMemberNames!(params)).rejects.toThrow();
    await send("/enable");
    expect(await service.getGroupMemberNames!(params)).toEqual({ ou_user: "Alice" });
    await expect(service.getGroupMemberNames!({ ...params, chatId: "oc_other" })).rejects.toThrow();
    await send("/disable");
    await expect(service.getGroupMemberNames!(params)).rejects.toThrow();
  });
  it("rejects a directory response after the group is disabled during lookup", async () => {
    const { send, service } = setup();
    await send("/enable");
    let finish!: (names: Record<string, string>) => void;
    directoryMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const reading = service.getGroupMemberNames!({ botId: "feishu-1", chatId: "oc_a" });
    const rejection = expect(reading).rejects.toThrow("unavailable");
    await vi.waitFor(() => expect(directoryMock).toHaveBeenCalledTimes(1));
    await send("/disable");
    finish({ ou_user: "Alice" });
    await rejection;
  });

  it("reconciles only saved unknown results in the currently authorized group", async () => {
    const { send, service, repo } = setup();
    await send("/enable");
    await send("work", "oc_a", "member");
    const state = await repo.readState();
    const context = Object.values(state.bots).find((value) => value.group)!;
    context.group!.deliveries = {
      unknown: {
        id: "unknown",
        taskId: context.activeTaskId!,
        text: "saved",
        status: "unknown",
        updatedAt: 1,
      },
    };
    await repo.writeState(state);
    expect(
      await service.reconcileGroupResult({
        botId: "feishu-1",
        chatId: "oc_a",
        deliveryId: "unknown",
        received: true,
      }),
    ).toMatchObject({ status: "sent", text: "saved" });
    await expect(
      service.reconcileGroupResult({
        botId: "feishu-1",
        chatId: "oc_a",
        deliveryId: "unknown",
        received: false,
      }),
    ).rejects.toThrow();
    context.group!.deliveries!.unknown!.status = "unknown";
    await send("/disable");
    await expect(
      service.reconcileGroupResult({
        botId: "feishu-1",
        chatId: "oc_a",
        deliveryId: "unknown",
        received: false,
      }),
    ).rejects.toThrow();
  });

  it("refuses to resend a saved result from an earlier authorization generation", async () => {
    const { send, service, repo } = setup();
    await send("/enable");
    await send("work", "oc_a", "member");
    const state = await repo.readState();
    const context = Object.values(state.bots).find((value) => value.group)!;
    context.group!.deliveries = {
      old: {
        id: "old",
        taskId: context.activeTaskId!,
        text: "old",
        status: "failed",
        authorizationId: "earlier-generation",
        updatedAt: 1,
      },
    };
    await repo.writeState(state);
    expect(
      await service.resendGroupResult({ botId: "feishu-1", chatId: "oc_a", deliveryId: "old" }),
    ).toMatchObject({ status: "invalidated" });
  });

  it("requires owner activation, keeps private state and two groups independent", async () => {
    const { service, send, repo } = setup();
    expect((await send("/enable", "oc_a", "member"))[0]?.text).toContain("绑定");
    expect((await service.getBotStates()).filter((s) => s.group)).toHaveLength(0);
    await service.handleInboundMessage({
      botId: "feishu-1",
      actor: {
        provider: "feishu",
        botId: "feishu-1",
        providerUserId: "ou_user",
        chatType: "private",
      },
      text: "/status",
    });
    await send("/enable");
    await send("/enable", "oc_b");
    const groups = (await service.getBotStates()).filter((s) => s.group);
    expect(groups).toHaveLength(2);
    expect(groups.map((s) => s.group?.chatId).sort()).toEqual(["oc_a", "oc_b"]);
    expect(groups.every((s) => s.draftOptions?.mode === "default")).toBe(true);
    const before = structuredClone(await repo.readState());
    await send("/enable");
    expect(await repo.readState()).toEqual(before);
    const memberStatus = await send("/status", "oc_a", "member");
    expect(memberStatus[0]?.providerUserId).toBe("oc_a");
    expect(memberStatus.map((r) => r.text).join("\n")).not.toContain("/tmp/workspace");
    expect((await send("/new", "oc_a", "member"))[0]?.text).toContain("绑定");
  });

  it("disables only the selected group and re-enables without resetting it", async () => {
    const { service, send } = setup();
    await send("/enable");
    await send("/enable", "oc_b");
    await send("/disable");
    let states = await service.getBotStates();
    expect(states.find((s) => s.group?.chatId === "oc_a")?.group?.enabled).toBe(false);
    expect(states.find((s) => s.group?.chatId === "oc_b")?.group?.enabled).toBe(true);
    expect((await send("hello", "oc_a", "member"))[0]?.text).toContain("启用");
    await send("/enable");
    states = await service.getBotStates();
    expect(states.find((s) => s.group?.chatId === "oc_a")?.group?.enabled).toBe(true);
  });
  it("does not readmit an accepted or uncertain provider message after in-memory dedupe is gone", async () => {
    const { send, taskService } = setup();
    await send("/enable");
    await send("accepted-once", "oc_a", "member");
    await send("accepted-once", "oc_a", "member");
    expect(taskService.submitBotGroupInput).toHaveBeenCalledOnce();
    vi.mocked(taskService.submitBotGroupInput).mockRejectedValueOnce(
      new Error("lost acknowledgement"),
    );
    await expect(send("uncertain-once", "oc_a", "member")).rejects.toThrow("lost acknowledgement");
    const retry = await send("uncertain-once", "oc_a", "member");
    expect(retry[0]?.text).toContain("核对");
    expect(taskService.submitBotGroupInput).toHaveBeenCalledTimes(2);
  });

  it("admits member inputs through the canonical queue without legacy send or yolo", async () => {
    const { send, taskService } = setup();
    await send("/enable");
    expect((await send("first", "oc_a", "member"))[0]?.text).toContain("等待执行");
    expect((await send("second", "oc_a", "other"))[0]?.text).toContain("等待执行");
    expect(taskService.createTask).toHaveBeenCalledTimes(1);
    expect(taskService.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ permissionScope: "session" }),
    );
    expect(taskService.sendPrompt).not.toHaveBeenCalled();
    expect(taskService.submitBotGroupInput).toHaveBeenCalledTimes(2);
    expect(taskService.submitBotGroupInput).toHaveBeenLastCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({
          chatId: "oc_a",
          senderId: "other",
          messageId: "om_second_other",
        }),
      }),
    );
    expect(taskService.setMode).toHaveBeenCalledWith(expect.objectContaining({ mode: "default" }));
  });

  it("does not resolve another group's task through the direct snapshot fallback", async () => {
    const { send, taskService } = setup();
    await send("/enable");
    await send("/task foreign-task");
    expect(taskService.getTaskSnapshot).not.toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "foreign-task" }),
    );
  });
  it("does not expose the local absolute workspace path in group status", async () => {
    const { send, service } = setup();
    await send("/enable");
    const path = (await service.getBotStates()).find((state) => state.group)!.workspacePath;
    expect(path.startsWith("/")).toBe(true);
    expect((await send("/status", "oc_a", "member"))[0]!.text).not.toContain(path);
  });

  it("inherits structured task selection into a topic instead of parsing its display model", async () => {
    const { send, taskService, repo } = setup(true);
    await send("/enable");
    await send("parent");
    const parent = Object.values((await repo.readState()).bots).find((value) => value.group)!;
    taskService.listTasks = vi.fn(async () => [
      {
        taskId: parent.activeTaskId!,
        provider: "glm",
        model: "glm/default$max",
        title: "Parent",
        workspacePath: "/tmp/workspace",
      },
    ]) as typeof taskService.listTasks;
    taskService.getTaskModelSelection = vi.fn(async () => ({
      providerId: "glm",
      modelId: "default",
      options: { reasoningLevel: "max" },
    }));
    await send("topic", "oc_a", "ou_user", "omt_selection");
    const topic = Object.values((await repo.readState()).bots).find(
      (value) => value.group?.threadId === "omt_selection",
    )!;
    expect(taskService.getTaskModelSelection).toHaveBeenCalledWith({ taskId: parent.activeTaskId });
    const creation = vi.mocked(taskService.createTask).mock.calls.at(-1)?.[0];
    expect(creation?.modelSelection ?? topic.draftOptions?.modelSelection).toEqual({
      providerId: "glm",
      modelId: "default",
      options: { reasoningLevel: "max" },
    });
  });

  it("inherits the group's explicit draft selection before any parent task exists", async () => {
    const { send, repo } = setup();
    await send("/enable");
    const state = await repo.readState();
    const parent = Object.values(state.bots).find((value) => value.group)!;
    parent.draftOptions = {
      provider: "glm",
      modelSelection: {
        providerId: "glm",
        modelId: "default",
        options: { reasoningLevel: "high" },
      },
    };
    await repo.writeState(state);
    await send("/status", "oc_a", "ou_user", "omt_draft");
    const topic = Object.values((await repo.readState()).bots).find(
      (value) => value.group?.threadId === "omt_draft",
    )!;
    expect(topic.draftOptions?.modelSelection).toEqual(parent.draftOptions.modelSelection);
  });

  it("inherits the current model selection when enabling a group", async () => {
    const { send, repo, service } = setup();
    const config = await repo.readConfig();
    const modelSelection = {
      providerId: "glm",
      modelId: "default",
      options: { reasoningLevel: "high" },
    };
    config.bots[0]!.currentOptions = { modelSelection, mode: "yolo" };
    await repo.writeConfig(config);
    await send("/enable");
    const group = (await service.getBotStates()).find((state) => state.group)?.group;
    expect(group?.currentOptions).toEqual({ modelSelection, mode: "default" });
  });

  it("does not inherit private sandbox and approval overrides", async () => {
    const { send, repo, service } = setup();
    const config = await repo.readConfig();
    config.bots[0]!.currentOptions = {
      mode: "yolo",
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
    };
    await repo.writeConfig(config);
    await send("/enable");
    const group = (await service.getBotStates()).find((s) => s.group)?.group;
    expect(group?.currentOptions).toEqual({ mode: "default" });
  });

  it("refuses new drafts while CLI still owns queued input, even without a bot running marker", async () => {
    const { send, taskService, service } = setup();
    taskService.getBotGroupTaskBlockReason = vi.fn(async () => "queued" as const);
    await send("/enable");
    await send("work", "oc_a", "member");
    const taskId = (await service.getBotStates()).find((s) => s.group)?.activeTaskId;
    const reply = await send("/new");
    expect(reply[0]?.text).toContain("排队");
    expect((await service.getBotStates()).find((s) => s.group)?.activeTaskId).toBe(taskId);
  });

  it.each([
    ["running", "运行"],
    ["queued", "排队"],
    ["interaction", "回答或审批"],
  ] as const)("reports the CLI blocking reason %s", async (reason, expected) => {
    const { send, taskService, service } = setup();
    taskService.getBotGroupTaskBlockReason = vi.fn(async () => reason);
    await send("/enable");
    await send("work", "oc_a", "member");
    const taskId = (await service.getBotStates()).find((value) => value.group)?.activeTaskId;
    expect((await send("/new"))[0]?.text).toContain(expected);
    expect((await service.getBotStates()).find((value) => value.group)?.activeTaskId).toBe(taskId);
  });

  it("opens a new draft after stop despite stale Bot permission options", async () => {
    const { send, repo, service, taskService } = setup();
    taskService.getBotGroupTaskBlockReason = vi.fn(async () => null);
    await send("/enable");
    await send("work", "oc_a", "member");
    const state = await repo.readState();
    const context = Object.values(state.bots).find((value) => value.group)!;
    context.pendingPermissionOptions = [
      {
        requestId: "stopped-permission",
        optionId: "allow_once",
        command: "approve",
        label: "Allow",
        response: { decision: "allow", reason: "Approved once" },
      },
    ];
    await repo.writeState(state);
    vi.mocked(taskService.getBotGroupTaskBlockReason).mockClear();
    await send("/new");
    expect(taskService.getBotGroupTaskBlockReason).toHaveBeenCalledOnce();
    const updated = (await service.getBotStates()).find((value) => value.group)!;
    expect(updated.activeTaskId).toBeNull();
    expect(updated.pendingPermissionOptions ?? []).toHaveLength(0);
  });

  it("allows only the queued input author or owner to cancel through CLI", async () => {
    const { send, taskService } = setup();
    taskService.cancelBotGroupInput = vi.fn(async (params) => ({
      commandId: params.commandId,
      status: "accepted",
      revisionAtDecision: 2,
    }));
    await send("/enable");
    const queued = await send("work", "oc_a", "member");
    const cancel = queued[0]?.selection?.options[0]?.id;
    expect(cancel).toMatch(/^\/queue-cancel /);
    await send(cancel!, "oc_a", "other");
    expect(taskService.cancelBotGroupInput).not.toHaveBeenCalled();
    await send(cancel!, "oc_a", "member");
    expect(taskService.cancelBotGroupInput).toHaveBeenCalledOnce();
  });

  it.each(["member", "ou_user"])(
    "rejects legacy topic queue cancellation even from %s",
    async (actorId) => {
      const { send, service, repo, taskService } = setup(true);
      taskService.cancelBotGroupInput = vi.fn();
      await send("/enable");
      await send("request A", "oc_a", "member", "omt_a");
      const before = await repo.readState();
      const context = before.bots[JSON.stringify(["feishu-1", "oc_a", "omt_a"])]!;
      const commandId = Object.keys(context.group!.inputs!)[0]!;
      const response = await service.handleInboundMessage({
        botId: "feishu-1",
        text: `/queue-cancel ${commandId}`,
        groupCard: {
          chatId: "oc_a",
          threadId: "omt_a",
          taskId: context.activeTaskId,
          authorizationId: context.group!.authorizationId,
        },
        actor: {
          botId: "feishu-1",
          provider: "feishu",
          chatType: "group",
          chatId: "oc_a",
          threadId: "omt_a",
          rootMessageId: "root_omt_a",
          providerUserId: actorId,
        },
      });
      expect(taskService.cancelBotGroupInput).not.toHaveBeenCalled();
      expect(response[0]?.callbackToastOnly).toBe(true);
      expect(
        (await repo.readState()).bots[JSON.stringify(["feishu-1", "oc_a", "omt_a"])]!.group!.inputs,
      ).toEqual(context.group!.inputs);
    },
  );

  it("admits queue cancellation while another input is waiting for CLI acknowledgement", async () => {
    const { send, taskService } = setup();
    taskService.cancelBotGroupInput = vi.fn(async (params) => ({
      commandId: params.commandId,
      status: "accepted",
      revisionAtDecision: 2,
    }));
    await send("/enable");
    const first = await send("first", "oc_a", "member");
    let release!: () => void;
    taskService.submitBotGroupInput = vi.fn(async (params) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        commandId: params.commandId,
        status: "accepted",
        revisionAtDecision: 2,
        result: { type: "inputAccepted", inputId: params.commandId, delivery: "queue" },
      };
    });
    const pending = send("second", "oc_a", "member");
    await vi.waitFor(() => expect(taskService.submitBotGroupInput).toHaveBeenCalled());
    try {
      await send(first[0]!.selection!.options[0]!.id, "oc_a", "member");
      expect(taskService.cancelBotGroupInput).toHaveBeenCalledOnce();
    } finally {
      release();
      await pending;
    }
  }, 2500);

  it("keeps a group's task selection when the private conversation opens a draft", async () => {
    const { send, service, taskService } = setup();
    taskService.getBotGroupTaskBlockReason = vi.fn(async () => null);
    await send("/enable");
    await send("work", "oc_a", "member");
    const created = await taskService.createTask.mock.results[0]!.value;
    taskService.listTasks = vi.fn(async () => [created]);
    await send("/new");
    const menu = await send("/task");
    expect(menu[0]?.selection?.options.length).toBeGreaterThan(0);
    await service.handleInboundMessage({
      botId: "feishu-1",
      actor: {
        botId: "feishu-1",
        provider: "feishu",
        providerUserId: "ou_user",
        chatType: "private",
      },
      text: "/new",
    });
    taskService.listTasks = vi.fn(async () => []);
    await send("/task 1");
    expect((await service.getBotStates()).find((value) => value.group)?.activeTaskId).toBe(
      "task-1",
    );
  });

  it("retains historical workspace identity when a group moves to another workspace", async () => {
    const { send, service, taskService, repo } = setup();
    taskService.getBotGroupTaskBlockReason = vi.fn(async () => null);
    await send("/enable");
    await send("history", "oc_a", "member");
    let state = await repo.readState();
    const context = Object.values(state.bots).find((value) => value.group)!;
    const originalPath = context.workspacePath;
    expect(context.group?.taskWorkspaces?.[context.activeTaskId!]).toMatchObject({
      workspacePath: originalPath,
    });
    const originalTaskId = context.activeTaskId!;
    context.workspacePath = "/another-group-workspace";
    context.workspaceIdentity = undefined;
    context.workspaceId = context.workspacePath;
    context.activeTaskId = null;
    context.mode = "draft";
    await repo.writeState(state);
    taskService.listTasks = vi.fn(async (params) =>
      params.workspacePath === originalPath
        ? [
            {
              taskId: originalTaskId,
              title: "Historical group task",
              workspacePath: originalPath,
              provider: "glm",
            },
          ]
        : [],
    );
    const menu = await send("/task");
    expect(menu[0]?.selection?.options.map((option) => option.id)).toContain(originalTaskId);
    expect((await service.getBotStates()).find((value) => value.group)?.activeTaskId).toBeNull();
  });

  it("invalidates group cards across disable and re-enable", async () => {
    const { send, service } = setup();
    await send("/enable");
    const previous = (await service.getBotStates()).find((s) => s.group)!;
    await send("/disable");
    await send("/enable");
    const reply = await service.handleInboundMessage({
      botId: "feishu-1",
      text: "/status",
      actor: {
        botId: "feishu-1",
        provider: "feishu",
        chatType: "group",
        chatId: "oc_a",
        providerUserId: "ou_user",
      },
      groupCard: {
        chatId: "oc_a",
        taskId: previous.activeTaskId,
        authorizationId: previous.group!.authorizationId!,
      },
    });
    expect(reply[0]?.callbackToastOnly).toBe(true);
    expect(reply[0]?.text).toContain("过期");
  });
  it("requires fresh group authorization after owner replacement, including changing back", async () => {
    const { send, service } = setup();
    await send("/enable");
    const config = structuredClone(await service.getConfig());
    config.bots[0]!.providerUserId = "new-owner";
    await service.saveConfig(config);
    config.bots[0]!.providerUserId = "ou_user";
    await service.saveConfig(config);
    expect((await service.getBotStates()).find((s) => s.group)?.group?.enabled).toBe(false);
    expect((await send("hello", "oc_a", "member"))[0]?.text).toContain("启用");
  });

  it("lets a replacement owner explicitly authorize a fresh group context", async () => {
    const { send, service } = setup();
    await send("/enable");
    const previous = (await service.getBotStates()).find((s) => s.group)!;
    const config = structuredClone(await service.getConfig());
    config.bots[0]!.providerUserId = "new-owner";
    await service.saveConfig(config);
    await send("/enable", "oc_a", "new-owner");
    const current = (await service.getBotStates()).find((s) => s.group)!;
    expect(current.group?.ownerId).toBe("new-owner");
    expect(current.group?.enabled).toBe(true);
    expect(current.group?.authorizationId).not.toBe(previous.group?.authorizationId);
    expect(current.activeTaskId).toBeNull();
    expect(current.group?.taskIds).toEqual([]);
  });

  it("cancels pending topic material when the bot is removed from the group", async () => {
    const { send, service, taskService } = setup();
    await send("/enable");
    let release!: () => void;
    historyMock.mockImplementationOnce(async (_bot, request) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { messages: [], checkpoint: request.messageId, hasGap: false };
    });
    const pending = send("removed material", "oc_a", "ou_user", "omt_removed");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const response = await service.handleProviderCallbackResponse("feishu", {
      botId: "feishu-1",
      zcodeBotRemoved: true,
      event: { chat_id: "oc_a" },
    });
    expect(response.ok).toBe(true);
    release();
    expect(await pending).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(taskService.createTask).not.toHaveBeenCalled();
    expect(taskService.submitBotGroupInput).not.toHaveBeenCalled();
  });

  it("rejects an unverified bot removal event before revoking a group", async () => {
    const { send, service, repo } = setup();
    await send("/enable");
    const config = await repo.readConfig();
    config.bots[0]!.webhookSecretRef = "verification-secret";
    await repo.writeConfig(config);
    // 测试凭据服务对未登记的引用返回 null；下面使用实际登记凭据的独立服务。
    const secured = f.createBotsService({
      zcodeTaskService: f.createLegacyTaskService(),
      repo: repo as never,
      credentialService: f.createCredentialService({ "verification-secret": "expected-token" }),
      runStartupBackgroundTasks: false,
    });
    services.push(secured);
    const response = await secured.handleProviderCallbackResponse("feishu", {
      botId: "feishu-1",
      zcodeBotRemoved: true,
      token: "incorrect-token",
      event: { chat_id: "oc_a" },
    });
    expect(response.ok).toBe(false);
    expect((await service.getBotStates()).find((s) => s.group)?.group?.enabled).toBe(true);
  });
  it("stops group synchronization on disable and restores only future events on enable", async () => {
    const { send, taskService } = setup();
    const dispose = vi.fn();
    const ready = vi.fn(async () => null);
    taskService.getBotGroupTaskBlockReason = ready;
    const subscribe = vi.fn(() => () => ({ dispose }));
    taskService.onDynamicTaskEvent = subscribe as never;
    await send("/enable");
    await send("E2E_GROUP_RESTORE", "oc_a", "member");
    expect(subscribe).toHaveBeenCalledOnce();
    await send("/disable");
    expect(dispose).toHaveBeenCalledOnce();
    await send("/enable");
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(ready).toHaveBeenCalled();
    expect(ready.mock.invocationCallOrder.at(-1)).toBeLessThan(
      subscribe.mock.invocationCallOrder.at(-1)!,
    );
    expect(taskService.submitBotGroupInput).toHaveBeenCalledOnce();
    expect(taskService.resumeTask).not.toHaveBeenCalled();
  });

  it("does not replay a persisted old message into the next group draft", async () => {
    const { send, taskService } = setup();
    taskService.getBotGroupTaskBlockReason = vi.fn(async () => null);
    await send("/enable");
    await send("persisted-message", "oc_a", "member");
    await send("/new");
    await send("persisted-message", "oc_a", "member");
    expect(taskService.createTask).toHaveBeenCalledOnce();
    expect(taskService.submitBotGroupInput).toHaveBeenCalledOnce();
  });
  it("persists the default group title after first admission", async () => {
    const { send, taskService } = setup();
    taskService.renameTask = vi.fn(async () => ({ taskId: "task-1" }) as never);
    await send("/enable");
    await send("first-title", "oc_a", "member");
    expect(taskService.renameTask).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task-1", title: "飞书 · 测试群" }),
    );
  });

  it("rejects an automation target that only has a legacy default-task alias", async () => {
    const { send, service, taskService, repo } = setup();
    await send("/enable");
    const state = await repo.readState();
    state.bots[JSON.stringify(["feishu-1", "oc_a"])].group!.topicAliases = {
      omt_reply: { taskId: "original-task", rootMessageId: "om_reply" },
    };
    await repo.writeState(state);
    taskService.onDynamicTaskEvent = vi.fn(() => () => ({ dispose() {} })) as never;
    await service.watchAutomationRun({
      workspacePath: "/tmp/workspace",
      taskId: "scheduled-task",
      target: {
        provider: "feishu",
        botId: "feishu-1",
        providerUserId: "oc_a",
        chatType: "group",
        threadId: "omt_reply",
        rootMessageId: "om_reply",
      },
    });
    expect(taskService.onDynamicTaskEvent).not.toHaveBeenCalled();
  });

  it("does not attach a topic automation after its group is disabled", async () => {
    const { send, service, taskService } = setup();
    taskService.onDynamicTaskEvent = vi.fn(() => () => ({ dispose() {} })) as never;
    await send("/enable");
    await send("/status", "oc_a", "ou_user", "omt_a");
    await send("/disable");
    await service.watchAutomationRun({
      workspacePath: "/tmp/workspace",
      taskId: "scheduled-task",
      target: {
        provider: "feishu",
        botId: "feishu-1",
        providerUserId: "oc_a",
        chatType: "group",
        threadId: "omt_a",
        rootMessageId: "root_omt_a",
      },
    });
    expect(taskService.onDynamicTaskEvent).not.toHaveBeenCalled();
  });

  it("does not attach an automation delivery watcher to a disabled group", async () => {
    const { send, service, taskService } = setup();
    taskService.onDynamicTaskEvent = vi.fn(() => () => ({ dispose() {} })) as never;
    await send("/enable");
    await send("/disable");
    await service.watchAutomationRun({
      workspacePath: "/tmp/workspace",
      taskId: "scheduled-task",
      target: { provider: "feishu", botId: "feishu-1", providerUserId: "oc_a", chatType: "group" },
    });
    expect(taskService.onDynamicTaskEvent).not.toHaveBeenCalled();
  });
});
