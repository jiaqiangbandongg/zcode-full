import { createGroupResultDelivery } from "#src/bots/groupResultDelivery.js";
import { describe, expect, it, vi } from "vitest";
import { replyToBotChannel } from "../src/bots/channelReply.js";
import type { BotsStateFile, BotsConfigFile, BotGroupDelivery } from "@zcode/shared";
const mention = {
  type: "channelMention" as const,
  refId: "m1",
  name: "Ryan Bot",
  channel: "feishu" as const,
  targetId: "ou_target",
  idType: "open_id" as const,
  entityType: "unknown" as const,
};
function fixture() {
  const source = {
    authorizationId: "auth",
    botId: "bot",
    appId: "app",
    provider: "feishu",
    chatId: "oc_group",
    senderId: "member",
    senderName: "Member",
    messageId: "om_input",
    contentParts: [mention],
  };
  const state = {
    version: 3,
    bots: {
      group: {
        botId: "bot",
        workspacePath: "/work",
        activeTaskId: "task",
        group: {
          enabled: true,
          ownerId: "owner",
          chatId: "oc_group",
          authorizationId: "auth",
          inputs: { input: { taskId: "task", admission: "accepted", source } },
          deliveries: {},
        },
      },
    },
  } as unknown as BotsStateFile;
  const config = {
    bots: [
      { id: "bot", enabled: true, provider: "feishu", providerUserId: "owner", feishuAppId: "app" },
    ],
  } as BotsConfigFile;
  const deliver = vi.fn(async (_bot, _chat, _thread, result: BotGroupDelivery) => {
    state.bots.group!.group!.deliveries![result.id] ??= {
      ...result,
      status: "sent",
      providerMessageId: "om_sent",
    };
  });
  const deps = { readState: async () => state, readConfig: async () => config, deliver };
  const request = {
    taskId: "task",
    inputId: "input",
    toolCallId: "call",
    authorizationId: "auth",
    workspacePath: "/work",
    parts: [
      { type: "mention" as const, refId: "m1" },
      { type: "text" as const, text: " 请确认" },
    ],
  };
  return { state, config, deps, request };
}
describe("authorized native channel reply", () => {
  it.each([false, true])(
    "waits for active delivery/retry (%s), but never resends a recovered unknown",
    async (retrying) => {
      const f = fixture();
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const joined = Promise.withResolvers<void>();
      const records = f.state.bots.group!.group!.deliveries!;
      let attempts = 0;
      const send = vi.fn(async () => {
        if (retrying && attempts++ === 0)
          throw Object.assign(new Error("rate limited"), {
            deliveryRejected: true,
            retryAfterMs: 250,
          });
        started.resolve();
        await release.promise;
        return { providerMessageId: "om_sent" };
      });
      const owner = createGroupResultDelivery({
        read: async (id) => records[id],
        write: async (result) => {
          records[result.id] = result;
        },
        authorized: async () => true,
        send,
        delay: async () => {
          started.resolve();
          await release.promise;
        },
      });
      let calls = 0;
      const deps = {
        ...f.deps,
        deliver: async (
          _bot: unknown,
          _chat: string,
          _thread: string | undefined,
          result: BotGroupDelivery,
        ) => {
          const pending = owner(result);
          if (++calls === 2) joined.resolve();
          await pending;
        },
      };
      const first = replyToBotChannel(f.request, deps);
      await started.promise;
      const second = replyToBotChannel(f.request, deps);
      try {
        expect(
          await Promise.race([second.then(() => "settled"), joined.promise.then(() => "waiting")]),
        ).toBe("waiting");
      } finally {
        release.resolve();
      }
      expect(await first).toMatchObject({ status: "sent" });
      expect(await second).toEqual(await first);
      expect(send).toHaveBeenCalledTimes(retrying ? 2 : 1);
      const record = Object.values(records)[0]!;
      records[record.id] = { ...record, status: "unknown", providerMessageId: undefined };
      const restarted = createGroupResultDelivery({
        read: async (id) => records[id],
        write: async (result) => {
          records[result.id] = result;
        },
        authorized: async () => true,
        send,
      });
      expect(
        await replyToBotChannel(f.request, {
          ...deps,
          deliver: async (_bot, _chat, _thread, result) => restarted(result),
        }),
      ).toMatchObject({ status: "unknown" });
      expect(send).toHaveBeenCalledTimes(retrying ? 2 : 1);
    },
  );

  it("resolves a unique typed name and replays the receipt without a new lookup", async () => {
    const f = fixture();
    const listMembers = vi.fn(async () => ({ ou_alice: "Alice" }));
    const deps = { ...f.deps, listMembers };
    const request = { ...f.request, parts: [{ type: "mentionName" as const, name: " Alice " }] };
    const first = await replyToBotChannel(request, deps);
    expect(first.status).toBe("sent");
    expect(f.deps.deliver.mock.calls[0]?.[3].contentParts).toEqual([
      expect.objectContaining({ type: "channelMention", targetId: "ou_alice", name: "Alice" }),
    ]);
    listMembers.mockRejectedValue(new Error("unavailable"));
    expect(await replyToBotChannel(request, deps)).toEqual(first);
    expect(listMembers).toHaveBeenCalledTimes(1);
    expect(f.deps.deliver).toHaveBeenCalledTimes(1);
    await expect(
      replyToBotChannel({ ...request, parts: [{ type: "text", text: "changed" }] }, deps),
    ).rejects.toThrow("idempotency");
  });
  it("returns ambiguous candidates without delivery and accepts only a valid selected candidate", async () => {
    const f = fixture();
    const deps = { ...f.deps, listMembers: async () => ({ ou_a: "Alex", ou_b: "Alex" }) };
    const request = { ...f.request, parts: [{ type: "mentionName" as const, name: "Alex" }] };
    const result = await replyToBotChannel(request, deps);
    expect(result.status).toBe("needs_clarification");
    expect(f.deps.deliver).not.toHaveBeenCalled();
    if (result.status !== "needs_clarification") throw new Error("Expected clarification");
    expect(result.unresolved[0]?.candidates).toHaveLength(2);
    const candidateRef = result.unresolved[0]!.candidates[1]!.ref;
    expect(candidateRef).not.toContain("ou_b");
    // 用户在下一条输入选择候选，标识应跨输入保留，但不能跨授权。
    const group = f.state.bots.group!.group!;
    group.inputs!.followup = {
      ...structuredClone(group.inputs!.input!),
      source: { ...group.inputs!.input!.source, messageId: "om_choice", contentParts: [] },
    };
    const selected = await replyToBotChannel(
      {
        ...request,
        inputId: "followup",
        toolCallId: "selected",
        parts: [{ type: "mentionName", name: "Alex", candidateRef }],
      },
      deps,
    );
    expect(selected.status).toBe("sent");
    expect(f.deps.deliver.mock.calls[0]?.[3].contentParts?.[0]).toMatchObject({ targetId: "ou_b" });
    expect(
      (
        await replyToBotChannel(
          { ...request, parts: [{ type: "mentionName", name: "Alex", candidateRef: "invented" }] },
          deps,
        )
      ).status,
    ).toBe("needs_clarification");
    expect(f.deps.deliver).toHaveBeenCalledTimes(1);
  });
  it("resolves a known bot name from trusted task mentions", async () => {
    const f = fixture();
    await replyToBotChannel(
      { ...f.request, parts: [{ type: "mentionName", name: "Ryan Bot" }] },
      {
        ...f.deps,
        listMembers: async () => ({}),
      },
    );
    expect(f.deps.deliver.mock.calls[0]?.[3].contentParts?.[0]).toMatchObject({
      targetId: "ou_target",
    });
  });
  it("resolves names from an earlier task without authorizing its mention refs", async () => {
    const f = fixture();
    const group = f.state.bots.group!.group!;
    group.inputs!.old = {
      ...structuredClone(group.inputs!.input!),
      taskId: "previous-task",
      progress: { status: "stopped" },
    };
    group.inputs!.input!.source.contentParts = [{ type: "text", text: "Find ryan" }];
    expect(
      await replyToBotChannel(
        { ...f.request, parts: [{ type: "mentionName", name: "ryan" }] },
        { ...f.deps, listMembers: async () => ({}) },
      ),
    ).toMatchObject({ status: "sent" });
    expect(f.deps.deliver.mock.calls[0]?.[3].contentParts?.[0]).toMatchObject({
      targetId: "ou_target",
      name: "Ryan Bot",
    });
    await expect(
      replyToBotChannel({ ...f.request, toolCallId: "old-ref" }, f.deps),
    ).rejects.toThrow();
  });
  it.each(["authorizationId", "chatId", "appId", "botId", "provider"] as const)(
    "excludes historical names from a different %s",
    async (field) => {
      const f = fixture();
      const group = f.state.bots.group!.group!;
      group.inputs!.old = { ...structuredClone(group.inputs!.input!), taskId: "previous-task" };
      Object.assign(group.inputs!.old.source, { [field]: "different" });
      group.inputs!.input!.source.contentParts = [{ type: "text", text: "Find ryan" }];
      const result = await replyToBotChannel(
        { ...f.request, parts: [{ type: "mentionName", name: "ryan" }] },
        { ...f.deps, listMembers: async () => ({}) },
      );
      expect(result).toMatchObject({
        status: "needs_clarification",
        unresolved: [{ reason: "not_found", candidates: [] }],
      });
      expect(f.deps.deliver).not.toHaveBeenCalled();
    },
  );
  it("treats a directory user and trusted bot with the same name as ambiguous", async () => {
    const f = fixture();
    const result = await replyToBotChannel(
      { ...f.request, parts: [{ type: "mentionName", name: "ryan bot" }] },
      { ...f.deps, listMembers: async () => ({ ou_person: "Ryan Bot" }) },
    );
    expect(result.status).toBe("needs_clarification");
    if (result.status !== "needs_clarification") throw new Error("Expected ambiguity");
    expect(result.unresolved[0]?.candidates).toHaveLength(2);
    expect(f.deps.deliver).not.toHaveBeenCalled();
  });
  it("does not partially deliver mixed resolved and missing recipients", async () => {
    const f = fixture();
    expect(
      (
        await replyToBotChannel(
          {
            ...f.request,
            parts: [
              { type: "mention", refId: "m1" },
              { type: "mentionName", name: "Unknown" },
            ],
          },
          { ...f.deps, listMembers: async () => ({}) },
        )
      ).status,
    ).toBe("needs_clarification");
    expect(f.deps.deliver).not.toHaveBeenCalled();
  });
  it("bounds duplicate-name output and rejects a candidate from another credential scope", async () => {
    const f = fixture();
    const deps = {
      ...f.deps,
      listMembers: async () =>
        Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`ou_member_${i}`, "Alex"])),
    };
    const request = { ...f.request, parts: [{ type: "mentionName" as const, name: "Alex" }] };
    const result = await replyToBotChannel(request, deps);
    if (result.status !== "needs_clarification") throw new Error("Expected ambiguity");
    expect(result.unresolved[0]?.candidates).toHaveLength(10);
    expect(result.unresolved[0]?.truncated).toBe(true);
    f.config.bots[0]!.credentialRef = "new-credential";
    const selected = await replyToBotChannel(
      {
        ...request,
        parts: [
          {
            type: "mentionName",
            name: "Alex",
            candidateRef: result.unresolved[0]!.candidates[0]!.ref,
          },
        ],
      },
      deps,
    );
    expect(selected).toMatchObject({
      status: "needs_clarification",
      unresolved: [expect.objectContaining({ reason: "selection_expired" })],
    });
    expect(f.deps.deliver).not.toHaveBeenCalled();
  });
  it("rejects binding changes during lookup even when the directory returns a unique match", async () => {
    const f = fixture();
    await expect(
      replyToBotChannel(
        { ...f.request, parts: [{ type: "mentionName", name: "Alice" }] },
        {
          ...f.deps,
          listMembers: async () => {
            f.config.bots[0]!.credentialRef = "changed";
            return { ou_alice: "Alice" };
          },
        },
      ),
    ).rejects.toThrow("authorization changed");
    expect(f.deps.deliver).not.toHaveBeenCalled();
  });
  it.each(["missing", "denied", "revoked"])("never sends for %s name lookup", async (kind) => {
    const f = fixture();
    const request = { ...f.request, parts: [{ type: "mentionName" as const, name: "Alice" }] };
    const deps = {
      ...f.deps,
      listMembers: async () => {
        if (kind === "denied") throw new Error("permission denied");
        if (kind === "revoked") f.state.bots.group!.group!.enabled = false;
        return kind === "missing" ? {} : { ou_alice: "Alice" };
      },
    };
    if (kind === "revoked") await expect(replyToBotChannel(request, deps)).rejects.toThrow();
    else expect((await replyToBotChannel(request, deps)).status).toBe("needs_clarification");
    expect(f.deps.deliver).not.toHaveBeenCalled();
  });
  it("uses trusted targets and returns the saved provider receipt", async () => {
    const { deps, request } = fixture();
    const result = await replyToBotChannel(request, deps);
    expect(result).toMatchObject({ status: "sent", providerMessageId: "om_sent" });
    expect(deps.deliver.mock.calls[0]?.[3]).toMatchObject({
      replyToMessageId: "om_input",
      contentParts: [mention, { type: "text", text: " 请确认" }],
    });
    expect(await replyToBotChannel(request, deps)).toEqual(result);
    await expect(
      replyToBotChannel({ ...request, parts: [{ type: "text", text: "different" }] }, deps),
    ).rejects.toThrow("idempotency");
  });
  it.each([undefined, "thread-1"])(
    "resolves desktop follow-up from task binding in %s",
    async (threadId) => {
      const { deps, request, state } = fixture();
      const group = state.bots.group!.group!;
      group.threadId = threadId;
      group.inputs!.input!.source.threadId = threadId;
      const { authorizationId: _authorizationId, ...followup } = request;
      const result = await replyToBotChannel({ ...followup, inputId: "desktop-input" }, deps);
      expect(result.status).toBe("sent");
      expect(deps.deliver.mock.calls[0]?.[2]).toBe(threadId);
      expect(deps.deliver.mock.calls[0]?.[3].contentParts?.[0]).toEqual(mention);
    },
  );
  it("reuses earlier native references while replying to the current input", async () => {
    const { deps, request, state } = fixture();
    const group = state.bots.group!.group!;
    group.inputs!.followup = {
      ...structuredClone(group.inputs!.input!),
      source: { ...group.inputs!.input!.source, messageId: "om_followup", contentParts: [] },
    };
    await replyToBotChannel({ ...request, inputId: "followup" }, deps);
    expect(deps.deliver.mock.calls[0]?.[3]).toMatchObject({
      replyToMessageId: "om_followup",
      contentParts: [mention, { type: "text", text: " 请确认" }],
    });
  });
  it("does not borrow targets from a different task even with a valid binding", async () => {
    const { deps, request, state } = fixture();
    const group = state.bots.group!.group!;
    group.inputs!.old = { ...structuredClone(group.inputs!.input!), taskId: "other-task" };
    group.inputs!.input!.source.contentParts = [];
    await expect(replyToBotChannel(request, deps)).rejects.toThrow("Unknown channel mention");
    expect(deps.deliver).not.toHaveBeenCalled();
  });
  it.each(["task", "thread", "oldAuthorization", "ambiguous", "identity"])(
    "rejects mismatched binding %s",
    async (kind) => {
      const { deps, request, state } = fixture();
      const group = state.bots.group!.group!;
      if (kind === "task") group.inputs!.input!.taskId = "other-task";
      if (kind === "thread") group.inputs!.input!.source.threadId = "other-thread";
      if (kind === "oldAuthorization") group.inputs!.input!.source.authorizationId = "old";
      if (kind === "ambiguous") state.bots.duplicate = structuredClone(state.bots.group!);
      if (kind === "identity") state.bots.group!.workspaceIdentity = "remote:other";
      await expect(
        replyToBotChannel({ ...request, inputId: "desktop-input" }, deps),
      ).rejects.toThrow();
      expect(deps.deliver).not.toHaveBeenCalled();
    },
  );
  it.each(["workspace", "app", "authorization", "unknownRef", "disabled", "stopped"])(
    "rejects %s without sending",
    async (kind) => {
      const { deps, request, state, config } = fixture();
      if (kind === "workspace") request.workspacePath = "/other";
      if (kind === "app") config.bots[0]!.feishuAppId = "other";
      if (kind === "authorization") request.authorizationId = "other";
      if (kind === "unknownRef") request.parts = [{ type: "mention", refId: "invented" }];
      if (kind === "stopped")
        state.bots.group!.group!.inputs!.input!.progress = { status: "stopped" };
      if (kind === "disabled") state.bots.group!.group!.enabled = false;
      await expect(replyToBotChannel(request, deps)).rejects.toThrow();
      expect(deps.deliver).not.toHaveBeenCalled();
    },
  );
});
