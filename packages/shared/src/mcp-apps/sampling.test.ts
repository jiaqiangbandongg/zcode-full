import { describe, expect, it } from "vitest";
import { mcpAppsSamplingParamsSchema } from "./sampling.js";

const base = {
  messages: [{ role: "user", content: { type: "text", text: "Explain fractions" } }],
  maxTokens: 200,
};
describe("MCP App sampling boundary", () => {
  it("accepts ordered text/image messages and advisory model hints", () => {
    expect(
      mcpAppsSamplingParamsSchema.parse({
        ...base,
        modelPreferences: { hints: [{ name: "other-model" }] },
      }),
    ).toMatchObject(base);
    expect(
      mcpAppsSamplingParamsSchema.safeParse({
        ...base,
        messages: [
          { role: "user", content: [{ type: "image", mimeType: "image/png", data: "AQ==" }] },
        ],
      }).success,
    ).toBe(true);
  });
  for (const extra of [
    { tools: [] },
    { includeContext: "allServers" },
    { temperature: 0 },
    { stopSequences: [] },
    { providerId: "injected" },
    { maxTokens: 0 },
  ])
    it(`rejects unsupported input ${JSON.stringify(extra)}`, () => {
      expect(mcpAppsSamplingParamsSchema.safeParse({ ...base, ...extra }).success).toBe(false);
    });
  for (const content of [
    { type: "audio", data: "AQ==", mimeType: "audio/wav" },
    { type: "resource_link", uri: "file:///secret" },
    { type: "image", mimeType: "image/png", data: "invalid!" },
    { type: "image", mimeType: "image/svg+xml", data: "AQ==" },
  ])
    it(`rejects unsupported or malformed block ${content.type}`, () => {
      expect(
        mcpAppsSamplingParamsSchema.safeParse({ ...base, messages: [{ role: "user", content }] })
          .success,
      ).toBe(false);
    });
});

it("bounds total blocks, UTF-8 text, metadata and decoded image bytes", () => {
  const parse = (messages: unknown[], extra = {}) =>
    mcpAppsSamplingParamsSchema.safeParse({ ...base, messages, ...extra });
  const blocks = Array.from({ length: 65 }, () => ({ type: "text", text: "x" }));
  expect(parse([{ role: "user", content: blocks }]).success).toBe(false);
  expect(
    parse([{ role: "user", content: { type: "text", text: "数".repeat(3 * 1024 * 1024) } }])
      .success,
  ).toBe(false);
  expect(parse(base.messages, { metadata: { payload: "x".repeat(8 * 1024 * 1024) } }).success).toBe(
    false,
  );
  const data = Buffer.alloc(4 * 1024 * 1024).toString("base64");
  expect(
    parse([{ role: "user", content: { type: "image", mimeType: "image/png", data } }]).success,
  ).toBe(true);
  expect(
    parse([
      { role: "user", content: { type: "image", mimeType: "image/png", data: data + "AAAA" } },
    ]).success,
  ).toBe(false);
});
