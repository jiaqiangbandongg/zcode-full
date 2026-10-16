import { describe, expect, it } from "vitest";
import type { TurnInputIntentMetadata } from "@zcode/contracts";
import { buildPersistedConversationInputIntent } from "../src/runtime/methods/input-intent-persistence.js";

describe("persisted conversation input intent", () => {
  it.each(["build", "guarded", "yolo"] as const)(
    "persists %s with canonical goal text and queue intent",
    (mode) => {
      const intent: TurnInputIntentMetadata = {
        sourceCommandId: "command-goal",
        queueItemId: "queue-goal",
        clientId: "desktop-goal",
        kind: "sendGoalCommand",
        text: "X",
        admissionSeq: 3,
        admittedAt: 999,
        requestedDelivery: "queue",
        admittedDelivery: "queue",
        modelSelection: {
          providerId: "account:bigmodel-team-coding-plan",
          modelId: "GLM-5.3",
          options: { reasoningLevel: "high" },
        },
        mode,
        sharedContextRefs: [{ kind: "shared_context_import", context_id: "context-1" }],
      };

      expect(
        buildPersistedConversationInputIntent("/GoAl replace X", intent, "queued"),
      ).toMatchObject({
        kind: "sendGoalCommand",
        text: "X",
        modelSelection: intent.modelSelection,
        mode,
        sharedContextRefs: intent.sharedContextRefs,
      });
    },
  );

  it("persists retry provenance with the rebuilt command intent", () => {
    const intent: TurnInputIntentMetadata = {
      sourceCommandId: "command-retry",
      queueItemId: "queue-retry",
      clientId: "desktop-new",
      kind: "sendText",
      text: "original text",
      admissionSeq: 4,
      admittedAt: 1000,
      requestedDelivery: "guide",
      admittedDelivery: "queue",
      provenance: {
        sourceCommandId: "command-original",
        queueItemId: "queue-original",
        clientId: "desktop-original",
      },
    };

    expect(buildPersistedConversationInputIntent("original text", intent, "drained")).toMatchObject(
      {
        sourceCommandId: "command-retry",
        provenance: {
          sourceCommandId: "command-original",
          queueItemId: "queue-original",
          clientId: "desktop-original",
        },
      },
    );
  });
});
