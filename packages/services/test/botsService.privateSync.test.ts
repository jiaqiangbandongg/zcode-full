import { afterEach, describe, expect, it, vi } from "vitest";
import type { BotsConfigFile, BotsStateFile, ZCodeStreamEvent } from "@zcode/shared";
import * as f from "./botsService.fixtures.js";

const services: ReturnType<typeof f.createBotsService>[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.disposeAllAndWait();
});

function setup(config: BotsConfigFile = f.telegramConfig) {
  const bot = config.bots[0]!;
  const state: BotsStateFile = {
    version: 3,
    bots: Object.fromEntries(
      config.bots.map((item) => [
        item.id,
        {
          botId: item.id,
          mode: "task",
          activeTaskId: "task-1",
          workspacePath: "/tmp/workspace",
          updatedAt: 1,
        },
      ]),
    ),
  };
  const repo = f.createMemoryRepo(config, state);
  const listeners = new Map<string, (event: ZCodeStreamEvent) => Promise<void> | void>();
  const tasks = f.createLegacyTaskService();
  const subscribe = vi.fn(
    (address: { taskId: string }) =>
      (listener: (event: ZCodeStreamEvent) => Promise<void> | void) => {
        listeners.set(address.taskId, listener);
        return { dispose: vi.fn(() => listeners.delete(address.taskId)) };
      },
  );
  Object.assign(tasks, { onDynamicTaskEvent: subscribe });
  const sent: Array<{ url: string; method?: string; body: Record<string, unknown> }> = [];
  const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    const body = JSON.parse(String(options?.body ?? "{}"));
    sent.push({ url: String(url), method: options?.method, body });
    if (String(url).includes("tenant_access_token"))
      return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant", expire: 7200 }));
    return new Response(
      JSON.stringify({
        ok: true,
        ret: 0,
        code: 0,
        data: { message_id: `msg-${sent.length}`, reaction_id: `reaction-${sent.length}` },
        result: { message_id: sent.length },
      }),
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  const credentials = f.createCredentialService({
    "telegram-token": "token",
    "feishu-secret": "secret",
    "weixin-token": "token",
  });
  const service = f.createBotsService({
    repo: repo as never,
    legacyTaskService: tasks,
    credentialService: credentials,
    runStartupBackgroundTasks: false,
  });
  services.push(service);
  const actor = {
    botId: bot.id,
    provider: bot.provider,
    providerUserId: bot.providerUserId!,
    chatType: "private" as const,
  };
  const emit = async (type: string, run: string, extras: Record<string, unknown> = {}) => {
    await listeners.get("task-1")?.({
      type,
      taskId: "task-1",
      traceId: run,
      inputId: run,
      ...extras,
    } as ZCodeStreamEvent);
  };
  const run = async (id: string, content: string, origin = "desktop") => {
    await emit("task_run_started", id, { inputOrigin: origin, startedAt: Date.now() });
    await emit("agent_message_chunk", id, { content });
    await emit("task_complete", id, { stopReason: "end_turn" });
  };
  return { service, repo, tasks, actor, emit, run, sent, subscribe, credentials, fetchMock };
}

describe("private task continuous delivery", () => {
  it("keeps private Typing until each run completes, including a reused subscription", async () => {
    const h = setup(f.feishuConfig);
    for (const id of ["first", "followup"]) {
      const messageId = `om-private-typing-${id}`;
      const response = await h.service.handleProviderCallbackResponse("feishu", {
        botId: h.actor.botId,
        event: {
          sender: { sender_type: "user", sender_id: { open_id: h.actor.providerUserId } },
          message: {
            message_id: messageId,
            chat_type: "p2p",
            message_type: "text",
            content: JSON.stringify({ text: "你好" }),
          },
        },
      });
      expect(response.ok).toBe(true);
      const reactions = () =>
        h.sent.filter((item) => item.url.includes(`/messages/${messageId}/reactions`));
      expect(reactions().filter((item) => item.method === "POST")).toHaveLength(1);
      expect(reactions().filter((item) => item.method === "DELETE")).toHaveLength(0);
      await h.emit("task_run_started", id, { inputOrigin: "desktop", startedAt: Date.now() });
      await h.emit("agent_message_chunk", id, { content: "正在处理" });
      expect(reactions().filter((item) => item.method === "DELETE")).toHaveLength(0);
      await h.emit("task_complete", id, { stopReason: "end_turn" });
      await vi.waitFor(() =>
        expect(reactions().filter((item) => item.method === "DELETE")).toHaveLength(1),
      );
    }
    expect(h.subscribe).toHaveBeenCalledTimes(1);
  });

  it.each([
    f.telegramConfig,
    f.feishuConfig,
    {
      ...f.weixinConfig,
      bots: f.weixinConfig.bots.map((bot) => ({ ...bot, providerUserId: "wx_user" })),
    },
  ])(
    "delivers IM then desktop and mobile turns independently: $bots.0.provider",
    async (config) => {
      const h = setup(config);
      await h.service.handleInboundMessage({
        botId: h.actor.botId,
        actor: { ...h.actor, providerContextToken: "latest-token" },
        text: "first input",
      });
      await h.run("im", "FIRST");
      await h.run("desktop", "SECOND");
      await h.run("mobile", "THIRD", "mobile");
      const replies = h.sent.filter((item) =>
        /sendMessage|sendmessage|im\/v1\/messages(?:\?|$)/.test(item.url),
      );
      expect(replies).toHaveLength(3);
      expect(JSON.stringify(replies[1])).toContain("SECOND");
      expect(JSON.stringify(replies[1])).not.toContain("FIRST");
      expect(JSON.stringify(replies[2])).toContain("THIRD");
      expect(h.subscribe).toHaveBeenCalledOnce();
    },
  );

  it("restores an existing binding on enable and invalidates it on disable", async () => {
    const h = setup();
    await h.service.saveConfig(await h.repo.readConfig());
    await h.run("desktop", "RESTORED");
    expect(h.sent.some((item) => JSON.stringify(item.body).includes("RESTORED"))).toBe(true);
    await h.service.saveConfig({
      ...f.telegramConfig,
      bots: f.telegramConfig.bots.map((bot) => ({ ...bot, enabled: false })),
    });
    const count = h.sent.length;
    await h.run("late", "MUST_NOT_SEND");
    expect(h.sent).toHaveLength(count);
  });

  it("fans out a shared task to both bound bots without duplicating subscriptions", async () => {
    const h = setup({ version: 3, bots: [...f.telegramConfig.bots, ...f.feishuConfig.bots] });
    await h.service.saveConfig(await h.repo.readConfig());
    await h.run("desktop", "BOTH");
    expect(h.subscribe).toHaveBeenCalledOnce();
    expect(
      h.sent.filter((item) => /sendMessage|im\/v1\/messages(?:\?|$)/.test(item.url)),
    ).toHaveLength(2);
  });
  it("keeps automation summary delivery unique and restores normal streaming on the next run", async () => {
    const h = setup();
    await h.service.saveConfig(await h.repo.readConfig());
    await h.service.watchAutomationRun({
      target: h.actor,
      taskId: "task-1",
      workspacePath: "/tmp/workspace",
    });
    await h.emit("task_run_started", "cron", { startedAt: 1 });
    await h.emit("agent_message_chunk", "cron", { content: "CRON" });
    expect(h.sent.filter((item) => item.url.includes("sendMessage"))).toHaveLength(0);
    await h.emit("task_complete", "cron", { stopReason: "end_turn" });
    await h.emit("task_complete", "cron", { stopReason: "end_turn" });
    expect(h.sent.filter((item) => item.url.includes("sendMessage"))).toHaveLength(1);
    await h.run("next", "NEXT");
    expect(h.sent.filter((item) => item.url.includes("sendMessage"))).toHaveLength(2);
    expect(h.subscribe).toHaveBeenCalledOnce();
  });

  it("does not expose desktop or mobile questions as actionable IM prompts", async () => {
    const h = setup();
    await h.service.saveConfig(await h.repo.readConfig());
    await h.emit("task_run_started", "desktop", { inputOrigin: "desktop", startedAt: 1 });
    await h.emit("elicitation_request", "desktop", {
      requestId: "question",
      message: "PRIVATE",
      options: [],
    });
    await h.emit("permission_request", "desktop", { requestId: "permission", options: [] });
    expect(h.sent).toHaveLength(0);
  });

  it("uses the latest Weixin token and restores it with the same credential service", async () => {
    const h = setup({
      ...f.weixinConfig,
      bots: f.weixinConfig.bots.map((bot) => ({ ...bot, providerUserId: "bot-self" })),
    });
    const actor = { ...h.actor, providerUserId: "wx-user", providerContextToken: "token-1" };
    await h.service.handleInboundMessage({ botId: actor.botId, actor, text: "/status" });
    await h.run("first", "FIRST");
    await h.service.handleInboundMessage({
      botId: actor.botId,
      actor: { ...actor, providerContextToken: "token-2" },
      text: "/status",
    });
    await h.run("second", "SECOND");
    let replies = h.sent.filter((item) => item.url.includes("sendmessage"));
    expect(JSON.stringify(replies[0])).toContain("token-1");
    expect(JSON.stringify(replies[1])).toContain("token-2");
    expect(JSON.stringify(await h.service.getBotStates())).not.toContain("token-2");
    await h.service.disposeAllAndWait();
    const restarted = f.createBotsService({
      repo: h.repo as never,
      legacyTaskService: h.tasks,
      credentialService: h.credentials,
      runStartupBackgroundTasks: false,
    });
    services.push(restarted);
    await restarted.saveConfig(await h.repo.readConfig());
    await h.run("third", "THIRD");
    replies = h.sent.filter((item) => item.url.includes("sendmessage"));
    expect(replies).toHaveLength(3);
    expect(JSON.stringify(replies[2])).toContain("token-2");
  });

  it("stops forwarding old tasks after switching the binding", async () => {
    const h = setup();
    await h.service.saveConfig(await h.repo.readConfig());
    vi.mocked(h.tasks.listTasks).mockResolvedValue([
      { taskId: "task-2", title: "Second", provider: "glm" },
    ] as never);
    await h.service.handleInboundMessage({
      botId: h.actor.botId,
      actor: h.actor,
      text: "/task task-2",
    });
    await h.run("old", "DO_NOT_FORWARD");
    expect(h.sent.filter((item) => item.url.includes("sendMessage"))).toHaveLength(0);
  });

  it("exposes failed delivery and retries explicitly with the refreshed Weixin token", async () => {
    const h = setup({
      ...f.weixinConfig,
      bots: f.weixinConfig.bots.map((bot) => ({ ...bot, providerUserId: "bot-self" })),
    });
    const actor = { ...h.actor, providerUserId: "wx-user", providerContextToken: "expired" };
    await h.service.handleInboundMessage({ botId: actor.botId, actor, text: "/status" });
    h.fetchMock.mockImplementation(async (url, options) => {
      h.sent.push({ url: String(url), body: JSON.parse(String(options?.body ?? "{}")) });
      return new Response(
        JSON.stringify(
          String(options?.body).includes("expired") && String(url).includes("sendmessage")
            ? { ret: -2, errmsg: "prepare failed" }
            : { ret: 0 },
        ),
      );
    });
    await h.run("failed", "RETRY_ME");
    const runtime = (await h.service.getStatus()).botRuntime[0]!;
    expect(runtime.deliveryError).toContain("微信");
    expect(runtime.deliveryRetryId).toBeTruthy();
    const count = h.sent.filter((item) => item.url.includes("sendmessage")).length;
    await h.service.handleInboundMessage({
      botId: actor.botId,
      actor: { ...actor, providerContextToken: "fresh" },
      text: "/status",
    });
    expect(h.sent.filter((item) => item.url.includes("sendmessage"))).toHaveLength(count);
    await h.service.retryPrivateDelivery!({
      botId: actor.botId,
      deliveryId: runtime.deliveryRetryId!,
    });
    expect(JSON.stringify(h.sent.at(-1))).toContain("fresh");
    expect(JSON.stringify(h.sent.at(-1))).toContain("RETRY_ME");
    expect((await h.service.getStatus()).botRuntime[0]?.deliveryRetryId).toBeUndefined();
  });
  it("does not let a queued automation change an unrelated current run", async () => {
    const h = setup();
    await h.service.saveConfig(await h.repo.readConfig());
    await h.emit("task_run_started", "current", { startedAt: 1 });
    await h.service.watchAutomationRun({
      target: h.actor,
      taskId: "task-1",
      workspacePath: "/tmp/workspace",
      runId: "cron-queued",
    });
    await h.emit("agent_message_chunk", "current", { content: "LIVE_CURRENT\n\n" });
    await h.emit("tool_call", "current", {
      toolId: "tool-current",
      name: "read",
      status: "running",
    });
    expect(h.sent.some((item) => JSON.stringify(item.body).includes("LIVE_CURRENT"))).toBe(true);
    await h.emit("task_complete", "current", { stopReason: "end_turn" });
    const before = h.sent.length;
    await h.emit("task_run_started", "cron-queued", { startedAt: 2 });
    await h.emit("agent_message_chunk", "cron-queued", { content: "CRON_FINAL\n\n" });
    await h.emit("tool_call", "cron-queued", {
      toolId: "tool-cron",
      name: "read",
      status: "running",
    });
    expect(h.sent).toHaveLength(before);
    await h.emit("task_complete", "cron-queued", { stopReason: "end_turn" });
    expect(h.sent).toHaveLength(before + 1);
  });

  it("invalidates a saved retry when the binding is removed", async () => {
    const h = setup();
    await h.service.saveConfig(await h.repo.readConfig());
    h.fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ ok: false, description: "blocked" }), { status: 403 }),
    );
    await h.run("failed", "FAILED");
    const id = (await h.service.getStatus()).botRuntime[0]!.deliveryRetryId!;
    expect(id).toBeTruthy();
    await h.service.resetBotState(h.actor.botId);
    await expect(
      h.service.retryPrivateDelivery!({ botId: h.actor.botId, deliveryId: id }),
    ).rejects.toThrow("no longer available");
  });
  it("records retry state for failures delivered inside a workspace mirror batch", async () => {
    const h = setup();
    await h.service.saveConfig(await h.repo.readConfig());
    h.fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ ok: false, description: "blocked" }), { status: 403 }),
    );
    const base = { taskId: "task-1", traceId: "mirror", inputId: "mirror" };
    await h.emit("task_stream_mirror_batch", "mirror", {
      ops: [
        {
          kind: "stream_event",
          event: { ...base, type: "task_run_started", startedAt: 1, inputOrigin: "mobile" },
        },
        {
          kind: "stream_event",
          event: { ...base, type: "agent_message_chunk", content: "MIRRORED" },
        },
        { kind: "stream_event", event: { ...base, type: "task_complete", stopReason: "end_turn" } },
      ],
    });
    expect((await h.service.getStatus()).botRuntime[0]?.deliveryRetryId).toBeTruthy();
  });
});
