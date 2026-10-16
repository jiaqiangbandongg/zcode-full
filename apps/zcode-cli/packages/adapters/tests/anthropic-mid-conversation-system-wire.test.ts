import { describe, expect, it, vi } from "vitest";

import { createAnthropicCompatFetch } from "../src/model/anthropic-stream-compat.js";

describe("Anthropic mid-conversation system wire shape", () => {
  it("restores a single plain text system block to string without changing other surfaces", async () => {
    const baseFetch = vi.fn(async () =>
      new Response("{}", { headers: { "content-type": "application/json" }, status: 400 }),
    );
    const fetch = createAnthropicCompatFetch(baseFetch as typeof globalThis.fetch);
    const topLevelSystem = [
      {
        cache_control: { type: "ephemeral" },
        text: "stable system prompt",
        type: "text",
      },
    ];
    const userContent = [{ text: "user prompt", type: "text" }];
    const cachedSystemContent = [
      {
        cache_control: { type: "ephemeral" },
        text: "cached system text",
        type: "text",
      },
    ];

    await fetch("https://provider.test/v1/messages", {
      body: JSON.stringify({
        messages: [
          { content: userContent, role: "user" },
          {
            content: [{ text: "runtime reminder", type: "text" }],
            role: "system",
          },
          { content: cachedSystemContent, role: "system" },
        ],
        system: topLevelSystem,
      }),
      method: "POST",
    });

    const requestInit = baseFetch.mock.calls[0]?.[1];
    const body = JSON.parse(String(requestInit?.body)) as Record<string, unknown>;
    expect(body.system).toEqual(topLevelSystem);
    expect(body.messages).toEqual([
      { content: userContent, role: "user" },
      { content: "runtime reminder", role: "system" },
      { content: cachedSystemContent, role: "system" },
    ]);
  });
});
