import { describe, expect, it } from "vitest";
import {
  assertCompleteToolHistory,
  assertProviderPrefix,
  assertProviderMessageHistory,
  assertRequestCacheBreakpoint,
  assertParentRequestHistory,
} from "./e2e/helpers/provider-prefix.js";

const cached = { type: "text", text: "question", cache_control: { type: "ephemeral" } };
const base = () => ({
  model: "parent",
  system: [{ type: "text", text: "stable system", cache_control: { type: "ephemeral" } }],
  tools: [{ name: "Agent", description: "stable pointer", input_schema: { type: "object" } }],
  messages: [{ role: "user", content: [structuredClone(cached)] }],
});
describe("provider prefix evidence", () => {
  it("allows child profile headers to change but rejects losing completed tool history", () => {
    const before = {
      ...base(),
      messages: [
        { role: "user", content: [{ type: "text", text: "original input" }] },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "child_read", name: "Read", input: { file_path: "fixture" } },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "child_read", content: "original result" }],
        },
      ],
    };
    const after = { ...structuredClone(before), model: "updated", system: [], tools: [] };
    after.messages.push({ role: "user", content: [{ type: "text", text: "resume" }] });
    expect(() => assertProviderMessageHistory(before, after)).not.toThrow();
    for (const mutated of [
      { ...after, messages: after.messages.slice(1) },
      {
        ...after,
        messages: [after.messages[0]!, after.messages[2]!, after.messages[1]!, after.messages[3]!],
      },
      {
        ...after,
        messages: after.messages.map((m, i) =>
          i === 2
            ? {
                role: "user",
                content: [
                  { type: "tool_result", tool_use_id: "child_read", content: "changed result" },
                ],
              }
            : m,
        ),
      },
    ])
      expect(() => assertProviderMessageHistory(before, mutated)).toThrow();
  });
  it("rejects orphan, missing, and system-interrupted tool results", () => {
    const request = base();
    const call = {
      role: "assistant",
      content: [{ type: "tool_use", id: "call", name: "Agent", input: {} }],
    };
    const result = {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call", content: "done" }],
    };
    expect(() =>
      assertCompleteToolHistory({ ...request, messages: [...request.messages, call, result] }),
    ).not.toThrow();
    expect(() =>
      assertCompleteToolHistory({ ...request, messages: [...request.messages, result] }),
    ).toThrow();
    expect(() =>
      assertCompleteToolHistory({ ...request, messages: [...request.messages, call] }),
    ).toThrow();
    expect(() =>
      assertCompleteToolHistory({
        ...request,
        messages: [...request.messages, call, { role: "system", content: "listing" }, result],
      }),
    ).toThrow();
  });
  it("accepts user block append and drifting cache marker, including MCS after breakpoint", () => {
    const before = base();
    const after = base();
    delete (after.messages[0]!.content[0] as Record<string, unknown>).cache_control;
    after.messages[0]!.content.push({ ...cached, text: "next input" });
    after.messages.push({
      role: "system",
      content: [{ type: "text", text: "New agent B" } as typeof cached],
    });
    expect(() => assertProviderPrefix(before, after)).not.toThrow();
    expect(() => assertParentRequestHistory([before, after])).not.toThrow();
    expect(() => assertRequestCacheBreakpoint(after)).not.toThrow();
  });
  it.each(["rewrite", "remove", "reorder", "system", "tools", "model"])(
    "rejects %s drift",
    (kind) => {
      const before = base();
      before.messages[0]!.content.unshift({ ...cached, text: "old listing" });
      const after = structuredClone(before);
      if (kind === "rewrite") after.messages[0]!.content[0]!.text = "new listing";
      if (kind === "remove") after.messages[0]!.content.shift();
      if (kind === "reorder") after.messages[0]!.content.reverse();
      if (kind === "system") after.system[0]!.text = "changed";
      if (kind === "tools") after.tools[0]!.description = "new embedded agent list";
      if (kind === "model") after.model = "other";
      expect(() => assertProviderPrefix(before, after)).toThrow();
      expect(() => assertParentRequestHistory([before, after])).toThrow();
    },
  );
  it("rejects a disappeared or misplaced message cache breakpoint", () => {
    const missing = base();
    delete (missing.messages[0]!.content[0] as Record<string, unknown>).cache_control;
    expect(() => assertRequestCacheBreakpoint(missing)).toThrow();
    expect(() => assertParentRequestHistory([missing])).toThrow();
    const misplaced = base();
    misplaced.messages.push({
      role: "user",
      content: [{ type: "text", text: "new input" } as typeof cached],
    });
    expect(() => assertRequestCacheBreakpoint(misplaced)).toThrow();
  });
});
