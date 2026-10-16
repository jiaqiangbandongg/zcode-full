import { describe, expect, it } from "vitest";
import { createTestModelSelection } from "./test-model-selection.js";
import { MessageHistoryImpl, countContextPrefixMessages } from "../src/agent/message-history.js";
import { buildProviderRequestMessages } from "../src/runtime/helpers/provider-request-messages.js";
import type { ContextBuildResult, ContextSection } from "../src/context/types.js";
import { estimateTokens } from "../src/context/utils.js";
import { buildContextHistoryEntries } from "../src/runtime/methods/context-history-entries.js";

describe("message history metadata", () => {
  it("preserves assistant model provenance through request-local clones", () => {
    const history = new MessageHistoryImpl();
    const model = createTestModelSelection("provider-a/model-a");

    history.addAssistant("answer", undefined, undefined, model);

    const entries = history.toRuntimeEntries();
    expect(entries[0]?.message).toMatchObject({ providerId: "provider-a", modelId: "model-a" });
    entries[0]!.message.providerId = "mutated" as never;
    expect(history.toRuntimeEntries()[0]?.message).toMatchObject({
      providerId: "provider-a",
      modelId: "model-a",
    });
  });

  it("preserves assistant tokens in runtime entries without exposing them to the provider", () => {
    const history = new MessageHistoryImpl();
    const tokens = {
      input: 100,
      output: 20,
      reasoning: 0,
      cache: { read: 0, write: 0 },
      total: 120,
    };

    history.addAssistant("answer", undefined, undefined, undefined, tokens);

    expect(history.toRuntimeEntries()[0]?.tokens).toEqual(tokens);
    expect(buildProviderRequestMessages({ entries: history.toRuntimeEntries() }).messages).toEqual([
      { role: "assistant", content: "answer" },
    ]);
    expect(JSON.stringify(buildProviderRequestMessages({ entries: history.toRuntimeEntries() }).messages)).not.toContain(
      "tokens",
    );
  });

  it("borrows the current authoritative runtime entries without cloning the array", () => {
    const history = new MessageHistoryImpl();
    history.addUser("first prompt", { source: "real_user" });

    const beforeAppend = history.borrowReadOnlyRuntimeEntries();
    const retainedMembership = [...beforeAppend];
    expect(history.borrowReadOnlyRuntimeEntries()).toBe(beforeAppend);

    history.addAssistant("second message");
    expect(history.borrowReadOnlyRuntimeEntries()).toBe(beforeAppend);
    expect(beforeAppend).toHaveLength(2);
    expect(retainedMembership).toHaveLength(1);

    history.replaceMessages([
      {
        message: { role: "user", content: "replacement prompt" },
        metadata: { source: "real_user" },
      },
    ]);

    const afterReplace = history.borrowReadOnlyRuntimeEntries();
    expect(afterReplace).not.toBe(beforeAppend);
    expect(beforeAppend).toHaveLength(2);
    expect(afterReplace).toEqual([
      {
        message: { role: "user", content: "replacement prompt" },
        metadata: { source: "real_user" },
      },
    ]);
  });

  it("does not expose provider-visible render helpers on message history", () => {
    const history = new MessageHistoryImpl();

    expect("toModelMessages" in history).toBe(false);
    expect("getCacheableMessages" in history).toBe(false);
    expect("getIncrementalMessages" in history).toBe(false);
  });

  it("stores system reminder attachments as structured entries rendered only by provider builder", () => {
    const history = new MessageHistoryImpl();
    history.addUser("real prompt", { source: "real_user" });
    history.addAttachment("output_style", "style body");

    expect(history.toRuntimeEntries()).toEqual([
      {
        message: {
          role: "user",
          content: "real prompt",
        },
        metadata: { source: "real_user" },
      },
      {
        kind: "attachment",
        content: "style body",
        metadata: { source: "output_style" },
      },
    ]);
    expect(buildProviderRequestMessages({ entries: history.toRuntimeEntries() }).messages).toEqual([
      {
        role: "user",
        content: "real prompt",
      },
      {
        role: "system",
        content: "style body",
      },
    ]);
  });

  it("stores internal metadata without leaking it to provider messages", () => {
    const history = new MessageHistoryImpl();
    history.init("system prompt");
    history.addUser("hook context", {
      source: "hook_context",
    });

    const providerMessages = buildProviderRequestMessages({
      entries: history.toRuntimeEntries(),
    }).messages;
    expect(providerMessages).toEqual([
      { role: "system", content: "system prompt" },
      { role: "user", content: "hook context" },
    ]);
    expect(JSON.stringify(providerMessages)).not.toContain("hook_context");

    const entries = history.toRuntimeEntries();
    expect(entries[1]?.metadata).toEqual({ source: "hook_context" });

    entries[1]!.message.content = "mutated";
    entries[1]!.metadata!.source = "real_user";
    expect(history.toRuntimeEntries()[1]).toMatchObject({
      message: { role: "user", content: "hook context" },
      metadata: { source: "hook_context" },
    });
  });

  it("counts metadata-marked request prefix before falling back to legacy text detection", () => {
    const history = new MessageHistoryImpl();
    history.init([
      { role: "system", content: "system prompt" },
      {
        message: { role: "user", content: "skill listing" },
        metadata: {
          source: "skills_listing",
        },
      },
      {
        message: {
          role: "user",
          content: "<system-reminder>\nthis is a real user badcase\n</system-reminder>",
        },
        metadata: {
          source: "real_user",
        },
      },
    ]);

    expect(countContextPrefixMessages(history.toRuntimeEntries())).toBe(2);
    expect(history.getCacheStats().cachedMessages).toBe(2);

    expect(
      countContextPrefixMessages([
        { role: "system", content: "system prompt" },
        { role: "user", content: "<system-reminder>\nlegacy prefix\n</system-reminder>" },
        { role: "user", content: "real user prompt" },
      ]),
    ).toBe(2);
  });

  it("builds skills listing context as a structured attachment entry", () => {
    const skillsSection = contextSection({
      name: "Available Skills",
      source: "skills",
      content: "# Skills\n- review: Inspect code",
    });
    const dateSection = contextSection({
      name: "Request User Context",
      source: "request_user_context",
      content: "# currentDate\nToday's date is 2026-06-17.",
    });
    const contextResult: ContextBuildResult = {
      sections: [skillsSection, dateSection],
      totalChars: skillsSection.chars + dateSection.chars,
      totalTokens: skillsSection.tokens + dateSection.tokens,
      systemMessages: [],
      metaUserAttachments: [
        {
          source: "skills_listing",
          content: "# Skills\n- review: Inspect code",
        },
        {
          source: "context_prefix",
          content:
            "As you answer the user's questions, you can use the following context:\n# currentDate\nToday's date is 2026-06-17.\n\n      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.",
        },
      ],
    };

    expect(buildContextHistoryEntries(contextResult)).toEqual([
      {
        kind: "attachment",
        content: "# Skills\n- review: Inspect code",
        metadata: { source: "skills_listing" },
      },
      {
        kind: "attachment",
        content:
          "As you answer the user's questions, you can use the following context:\n# currentDate\nToday's date is 2026-06-17.\n\n      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.",
        metadata: { source: "context_prefix" },
      },
    ]);
  });
});

function contextSection(input: {
  name: string;
  source: ContextSection["source"];
  content: string;
}): ContextSection {
  return {
    name: input.name,
    source: input.source,
    injectionTarget: "meta_user",
    cacheHint: "dynamic",
    content: input.content,
    chars: input.content.length,
    tokens: estimateTokens(input.content),
    preview: input.content.slice(0, 100),
  };
}
