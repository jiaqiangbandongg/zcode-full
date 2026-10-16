import { expect, it } from "vitest";
import type { BotInboundMessage } from "@zcode/shared";
import { createTopicPreparationState } from "../src/bots/topicPreparationState.js";

it("isolates topic preparation and exposes no attachment payload in its UI snapshot", () => {
  const state = createTopicPreparationState();
  const message = {
    text: "request",
    actor: { providerMessageId: "m", providerUserId: "u", displayName: "User" },
    attachments: [{ dataBase64: "private-file" }],
  } as BotInboundMessage;
  state.add("topic-a", message);
  expect(state.snapshot("topic-b")).toEqual([]);
  expect(JSON.stringify(state.snapshot("topic-a"))).not.toContain("private-file");
  expect(state.retry("topic-a", "m")).toBeUndefined();
  state.update("topic-a", ["m"], "failed", "Download failed");
  expect(state.retry("topic-a", "m")).toBe(message);
  state.clear("topic-a");
  expect(state.retry("topic-a", "m")).toBeUndefined();
  expect(state.snapshot("topic-a")).toEqual([]);
});

it("keeps messages arriving during stop in waitingStop until stop completes", () => {
  const state = createTopicPreparationState();
  const message = {
    text: "request",
    actor: { providerMessageId: "m", providerUserId: "u" },
  } as BotInboundMessage;
  state.setWaitingStop("topic", true);
  state.add("topic", message);
  expect(state.snapshot("topic")[0]?.status).toBe("waitingStop");
  state.setWaitingStop("topic", false);
  expect(state.snapshot("topic")[0]?.status).toBe("preparing");
  state.update("topic", ["m"], "failed", "error");
  state.setWaitingStop("topic", true);
  state.setWaitingStop("topic", false);
  expect(state.snapshot("topic")[0]?.status).toBe("failed");
  state.clear("topic");
  state.add("topic", message);
  expect(state.snapshot("topic")[0]?.status).toBe("preparing");
});
