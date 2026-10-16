import { describe, expect, it } from "vitest";

import {
  ensureConversationShareAttempt,
  type ConversationShareAttempt,
} from "@/v4/conversationShareAttempt.js";

describe("conversation share attempt identity", () => {
  it("keeps the disclosure timestamp and request id stable for a retry", () => {
    const first = ensureConversationShareAttempt(null, "same-attempt", "session-1", {
      now: () => 1_000,
      randomUUID: () => "request-1",
    });
    const retry = ensureConversationShareAttempt(first, "same-attempt", "session-1", {
      now: () => 2_000,
      randomUUID: () => "request-2",
    });

    expect(retry).toBe(first);
    expect(retry).toEqual<ConversationShareAttempt>({
      key: "same-attempt",
      clientRequestId: "share-request-1",
      disclosureAcceptedAt: 1_000,
    });
  });

  it("starts a new attempt when the publication key changes", () => {
    const first = ensureConversationShareAttempt(null, "attempt-1", "session-1", {
      now: () => 1_000,
      randomUUID: () => "request-1",
    });
    const next = ensureConversationShareAttempt(first, "attempt-2", "session-1", {
      now: () => 2_000,
      randomUUID: () => "request-2",
    });

    expect(next).toEqual({
      key: "attempt-2",
      clientRequestId: "share-request-2",
      disclosureAcceptedAt: 2_000,
    });
  });
});
