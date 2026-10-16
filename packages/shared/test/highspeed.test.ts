import { describe, expect, it } from "vitest";
import {
  highspeedDrawResponseSchema,
  highspeedMessageMetaSchema,
} from "../src/highspeed.js";

describe("Highspeed contracts", () => {
  it("parses draw card and authoritative next_draw_at", () => {
    const parsed = highspeedDrawResponseSchema.parse({
      code: 0,
      msg: "success",
      data: {
        card: {
          card_id: "hsc-1",
          task_id: "task-1",
          provider: "zai",
          model: "glm-5",
          issued_at: 1_786_413_600_000,
          expires_at: 1_786_414_500_000,
        },
        next_draw_at: 1_786_417_200_000,
      },
    });

    expect(parsed.data.card?.task_id).toBe("task-1");
    expect(parsed.data.next_draw_at).toBe(1_786_417_200_000);
  });

  it("accepts miss responses without losing cooldown", () => {
    const parsed = highspeedDrawResponseSchema.parse({
      code: 0,
      msg: "success",
      data: { card: null, next_draw_at: 2000 },
    });
    expect(parsed.data).toEqual({ card: null, next_draw_at: 2000 });
  });

  it("keeps persisted message metadata strict and versioned", () => {
    const metadata = {
      schemaVersion: 1,
      cardId: "hsc-1",
      taskId: "task-1",
      provider: "zai",
      model: "glm-5",
      issuedAt: 1_000,
      expiresAt: 10_000,
      regularTps: 73.5,
      outputTokens: 120_000,
      durationMs: 881_000,
      highspeedTps: 90,
      savedDurationMs: 751_653,
      modelDurationMs: 700_000,
      toolDurationMs: 120_000,
      otherDurationMs: 61_000,
    };

    expect(highspeedMessageMetaSchema.parse(metadata)).toEqual(metadata);
    expect(() => highspeedMessageMetaSchema.parse({ ...metadata, cardId: "" })).toThrow();
    expect(() => highspeedMessageMetaSchema.parse({ ...metadata, regularTps: 0 })).toThrow();
    expect(() => highspeedMessageMetaSchema.parse({ ...metadata, savedDurationMs: -1 })).toThrow();
    expect(() => highspeedMessageMetaSchema.parse({ ...metadata, extra: true })).toThrow();
  });

});
