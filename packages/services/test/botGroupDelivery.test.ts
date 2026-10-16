import { describe, expect, it, vi } from "vitest";
import { createGroupResultDelivery } from "../src/bots/groupResultDelivery.js";
import { botGroupDeliverySchema, type BotGroupDelivery } from "@zcode/shared";

describe("saved group results", () => {
  it.each(["root", "original"])(
    "stops topic fallback at its root (%s) and preserves mentions",
    async (rootMessageId) => {
      let saved: BotGroupDelivery | undefined;
      const send = vi.fn(async () => {
        throw Object.assign(new Error("recalled"), {
          deliveryRejected: true,
          deliveryReplyUnavailable: true,
        });
      });
      const deliver = createGroupResultDelivery({
        read: async () => saved,
        write: async (value) => {
          saved = value;
        },
        authorized: async () => true,
        send,
      });
      await deliver({
        id: "topic",
        taskId: "task",
        text: "answer",
        status: "pending",
        updatedAt: 1,
        threadId: "omt_thread",
        rootMessageId,
        replyToMessageId: "original",
        mentionedUserIds: ["ou_alice"],
      });
      expect(send).toHaveBeenCalledTimes(rootMessageId === "original" ? 1 : 2);
      expect(saved).toMatchObject({
        status: "failed",
        replyToMessageId: rootMessageId,
        mentionedUserIds: ["ou_alice"],
      });
    },
  );

  it("restores the saved recipient snapshot instead of using new retry arguments", async () => {
    let saved = botGroupDeliverySchema.parse(
      JSON.parse(
        JSON.stringify({
          id: "restored",
          taskId: "task",
          text: "saved answer",
          status: "failed",
          updatedAt: 1,
          replyToMessageId: "om_alice",
          mentionedUserIds: ["ou_alice"],
        }),
      ),
    );
    const send = vi.fn(async () => ({ providerMessageId: "om_result" }));
    const restored = createGroupResultDelivery({
      read: async () => saved,
      write: async (value) => {
        saved = botGroupDeliverySchema.parse(value);
      },
      authorized: async () => true,
      send,
    });
    await restored({ ...saved, replyToMessageId: "om_bob", mentionedUserIds: ["ou_bob"] }, true);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ replyToMessageId: "om_alice", mentionedUserIds: ["ou_alice"] }),
    );
    expect(saved.status).toBe("sent");
    const { mentionedUserIds: _mentions, ...legacy } = saved;
    expect(botGroupDeliverySchema.parse(legacy).mentionedUserIds).toBeUndefined();
  });

  it("persists the native result message ID for follow-up topic routing", async () => {
    let saved: BotGroupDelivery | undefined;
    const deliver = createGroupResultDelivery({
      read: async () => saved,
      write: async (value) => {
        saved = value;
      },
      authorized: async () => true,
      send: async () => ({ providerMessageId: "om_result" }),
    });
    await deliver({ id: "result", taskId: "task", text: "reply", status: "pending", updatedAt: 1 });
    expect(saved).toMatchObject({ status: "sent", providerMessageId: "om_result" });
  });
  it.each([false, true])(
    "projects in-flight sends as pending and publishes settled state (timeout=%s)",
    async (timeout) => {
      let saved: BotGroupDelivery | undefined;
      let finish!: () => void;
      const gate = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const settled: string[] = [];
      const deliver = createGroupResultDelivery({
        read: async () => saved,
        write: async (value) => {
          saved = value;
        },
        authorized: async () => true,
        send: async () => {
          await gate;
          if (timeout) throw new Error("timeout");
        },
        onSettled: async () => {
          settled.push(deliver.project(saved!).status);
        },
      });
      const operation = deliver({
        id: "active",
        taskId: "task",
        sourceCommandId: "command",
        text: "reply",
        status: "pending",
        updatedAt: 1,
      });
      await vi.waitFor(() => expect(saved?.status).toBe("unknown"));
      expect(deliver.project(saved!).status).toBe("pending");
      expect(saved?.status).toBe("unknown");
      finish();
      await operation;
      expect(settled).toEqual([timeout ? "unknown" : "sent"]);
      expect(saved?.sourceCommandId).toBe("command");
    },
  );

  it("checks the delivery generation again after disable and immediate re-enable", async () => {
    let generation = "first";
    let saved: BotGroupDelivery | undefined;
    const send = vi.fn(async () => {
      throw Object.assign(new Error("rate limit"), { deliveryRejected: true, retryAfterMs: 1000 });
    });
    const deliver = createGroupResultDelivery({
      read: async () => saved,
      write: async (value) => {
        saved = value;
      },
      authorized: async (result) => result.authorizationId === generation,
      send,
      delay: async () => {
        generation = "second";
      },
    });
    await deliver({
      id: "generation",
      taskId: "task",
      text: "old result",
      authorizationId: "first",
      status: "pending",
      updatedAt: 1,
    });
    expect(send).toHaveBeenCalledOnce();
    expect(saved?.status).toBe("invalidated");
  });

  it("retains uncertain sends and never automatically repeats them", async () => {
    let record: BotGroupDelivery | undefined;
    const send = vi.fn(async () => {
      throw new Error("timeout");
    });
    const deliver = createGroupResultDelivery({
      read: async (id) => (record?.id === id ? record : undefined),
      write: async (value) => {
        record = value;
      },
      authorized: async () => true,
      send,
    });
    const result = {
      id: "d1",
      taskId: "task",
      text: "saved answer",
      mentionedUserIds: ["ou_alice"],
      updatedAt: 1,
      status: "pending" as const,
    };
    await deliver(result);
    expect(record?.status).toBe("unknown");
    await deliver(result);
    await deliver(result, true);
    expect(send).toHaveBeenCalledOnce();
  });
  it("retries saved rejected results, and invalidates results after task switching", async () => {
    let record: BotGroupDelivery | undefined;
    let authorized = true;
    const send = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("rate limited"), { deliveryRejected: true }))
      .mockResolvedValue(undefined);
    const deliver = createGroupResultDelivery({
      read: async (id) => (record?.id === id ? record : undefined),
      write: async (value) => {
        record = value;
      },
      authorized: async () => authorized,
      send,
    });
    const result = {
      id: "d1",
      taskId: "task",
      text: "saved answer",
      mentionedUserIds: ["ou_alice"],
      updatedAt: 1,
      status: "pending" as const,
    };
    await deliver(result);
    expect(record?.status).toBe("failed");
    await deliver(result, true);
    expect(record?.status).toBe("sent");
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: "saved answer", mentionedUserIds: ["ou_alice"] }),
    );
    authorized = false;
    await deliver({ ...result, id: "d2" });
    expect(record?.status).toBe("invalidated");
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("rechecks authorization after rate limiting and before same-group fallback", async () => {
    const records = new Map<string, BotGroupDelivery>();
    let authorized = true;
    const send = vi.fn().mockRejectedValueOnce(
      Object.assign(new Error("throttled"), {
        deliveryRejected: true,
        retryAfterMs: 1000,
      }),
    );
    const deliver = createGroupResultDelivery({
      read: async (id) => records.get(id),
      write: async (result) => {
        records.set(result.id, result);
      },
      authorized: async () => authorized,
      send,
      delay: async () => {
        authorized = false;
      },
    });
    const result: BotGroupDelivery = {
      id: "r",
      taskId: "task",
      text: "saved",
      status: "pending",
      updatedAt: 1,
    };
    await deliver(result);
    expect(send).toHaveBeenCalledOnce();
    expect(records.get("r")?.status).toBe("invalidated");
    authorized = true;
    const fallbackSend = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("recalled"), {
          deliveryRejected: true,
          deliveryReplyUnavailable: true,
        }),
      )
      .mockResolvedValue(undefined);
    const fallback = createGroupResultDelivery({
      read: async (id) => records.get(id),
      write: async (result) => {
        records.set(result.id, result);
      },
      authorized: async () => authorized,
      send: fallbackSend,
    });
    await fallback({
      ...result,
      id: "f",
      replyToMessageId: "original",
      mentionedUserIds: ["ou_alice"],
    });
    expect(fallbackSend).toHaveBeenCalledTimes(2);
    expect(fallbackSend.mock.calls[1]?.[0]).toMatchObject({
      id: "f",
      taskId: "task",
      text: "saved",
    });
    expect(fallbackSend.mock.calls[1]?.[0].replyToMessageId).toBeUndefined();
    expect(records.get("f")?.status).toBe("sent");
    expect(records.get("f")?.mentionedUserIds).toEqual(["ou_alice"]);
  });
});
