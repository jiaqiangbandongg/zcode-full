import { describe, expect, it, vi } from "vitest";
import { compileModelOptionMaps } from "@zcode/model-option-map";
import { createModelOptionMapFetch } from "../src/model/model-option-map-fetch.js";

describe("createModelOptionMapFetch", () => {
  it.each([
    {
      name: "Anthropic Messages",
      reasoningMap:
        "reasoningLevel == 'off' ? {'thinking': {'type': 'disabled'}} : {'thinking': {'type': 'enabled'}}",
      maxMap: "{'max_tokens': maxOutputTokens}",
      expected: { thinking: { type: "enabled" }, max_tokens: 32000 },
    },
    {
      name: "OpenAI Chat Completions",
      reasoningMap: "{'reasoning_effort': reasoningLevel}",
      maxMap: "{'max_completion_tokens': maxOutputTokens}",
      expected: { reasoning_effort: "high", max_completion_tokens: 32000 },
    },
    {
      name: "OpenAI Responses",
      reasoningMap: "{'reasoning': {'effort': reasoningLevel}}",
      maxMap: "{'max_output_tokens': maxOutputTokens}",
      expected: { reasoning: { effort: "high" }, max_output_tokens: 32000 },
    },
  ])("patches the final $name raw JSON body", async ({ reasoningMap, maxMap, expected }) => {
    let sentBody: unknown;
    const transport = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body));
      return new Response("{}", { status: 200 });
    });
    const capture: { body?: Record<string, unknown> } = {};
    const fetch = createModelOptionMapFetch({
      capture,
      fetch: transport,
      maps: compileModelOptionMaps({
        reasoningLevel: { map: reasoningMap },
        maxOutputTokens: { map: maxMap },
      }),
      values: { reasoningLevel: "high", maxOutputTokens: 32000 },
    });

    await fetch("https://example.com", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "example", untouched: true }),
    });

    expect(sentBody).toEqual({ model: "example", untouched: true, ...expected });
    expect(capture.body).toEqual(sentBody);
  });

  it("does not mutate or reuse a previous request body", async () => {
    const bodies: unknown[] = [];
    const fetch = createModelOptionMapFetch({
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response("{}");
      },
      maps: compileModelOptionMaps({
        reasoningLevel: { map: "{}" },
        maxOutputTokens: { map: "{'max_tokens': maxOutputTokens}" },
      }),
      values: { reasoningLevel: "disabled", maxOutputTokens: 7 },
    });

    await fetch("https://example.com", { method: "POST", body: '{"model":"a"}' });
    await fetch("https://example.com", { method: "POST", body: '{"model":"b"}' });

    expect(bodies).toEqual([
      { model: "a", max_tokens: 7 },
      { model: "b", max_tokens: 7 },
    ]);
  });

  it("makes the option map authoritative over SDK-produced option fields", async () => {
    let sentBody: unknown;
    const fetch = createModelOptionMapFetch({
      fetch: async (_input, init) => {
        sentBody = JSON.parse(String(init?.body));
        return new Response("{}");
      },
      maps: compileModelOptionMaps({
        reasoningLevel: { map: "{'reasoning_effort': reasoningLevel}" },
        maxOutputTokens: { map: "{'max_completion_tokens': maxOutputTokens}" },
      }),
      values: { reasoningLevel: "low", maxOutputTokens: 32000 },
    });

    await fetch("https://example.com", {
      method: "POST",
      body: JSON.stringify({
        model: "example",
        reasoning_effort: "high",
        max_completion_tokens: 1,
      }),
    });

    expect(sentBody).toEqual({
      model: "example",
      reasoning_effort: "low",
      max_completion_tokens: 32000,
    });
  });

  it("fails closed when a model request body is not JSON text", async () => {
    const transport = vi.fn(async () => new Response("{}"));
    const fetch = createModelOptionMapFetch({
      fetch: transport,
      maps: compileModelOptionMaps({
        reasoningLevel: { map: "{}" },
        maxOutputTokens: { map: "{'max_tokens': maxOutputTokens}" },
      }),
      values: { reasoningLevel: "disabled", maxOutputTokens: 7 },
    });

    await expect(
      fetch("https://example.com", {
        method: "POST",
        body: new Uint8Array([123, 125]),
      }),
    ).rejects.toThrow("JSON text request body");
    expect(transport).not.toHaveBeenCalled();
  });
});
