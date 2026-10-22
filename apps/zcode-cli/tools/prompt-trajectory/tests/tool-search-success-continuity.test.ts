import { deepStrictEqual, equal } from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveTrajectoriesFromModelIoEntries } from "../src/model-io.js";
import { toolSearchComparisonMessages } from "../src/tool-search-comparison.js";
import type { OpenAiMessage } from "../src/types.js";

const options = { ignoreToolSearchChanges: true };
const text = (value: string) => ({ type: "text", text: value });
const loaded = text("Tool loaded.");
const reference = { type: "tool_reference", tool_name: "WebFetch" };
const disabled = text("[Tool references removed - tool search not enabled]");
const removed = text("[Tool references removed - tools no longer available]");
const result = (id: string, content: unknown[], isError = false) => ({
  type: "tool_result",
  tool_use_id: id,
  content,
  is_error: isError,
});
const user = (content: unknown[]): OpenAiMessage => ({ role: "user", content });
const calls: OpenAiMessage = {
  role: "assistant",
  content: [
    { type: "tool_use", id: "search", name: "ToolSearch", input: { query: "web" } },
    { type: "tool_use", id: "read", name: "Read", input: { file_path: "a.txt" } },
    { type: "tool_use", id: "second", name: "ToolSearch", input: { query: "fetch" } },
  ],
};
const record = (messages: OpenAiMessage[]) => ({
  querySource: "main_turn",
  request: { body: { model: "test", messages } },
});

describe("ToolSearch success feedback in trajectory comparison", () => {
  for (const placeholder of [disabled, removed]) {
    it(`ignores derived feedback through ${placeholder.text} and restoration`, () => {
      // 最终 Anthropic wire 将整批结果、每个搜索的成功提示及后续 user 正文合并。
      const batch = (content: unknown[]) => [
        result("search", [text("before"), ...content, text("Hook context")]),
        result("read", [text("file contents")]),
        result("second", content),
      ];
      const native = [calls, user([...batch([reference, reference]), loaded, loaded])];
      const off = [calls, user([...batch([placeholder]), text("continue")])];
      const restored = [
        calls,
        user([
          ...batch([reference, reference]),
          loaded,
          { ...loaded, cache_control: { type: "ephemeral" } },
          text("continue"),
          text("next"),
        ]),
      ];
      const records = [native, off, restored].map(record);
      const before = structuredClone(records);
      equal(deriveTrajectoriesFromModelIoEntries(records).trajectories.length, 3);
      const merged = deriveTrajectoriesFromModelIoEntries(records, options);
      equal(merged.trajectories.length, 1);
      equal(merged.trajectories[0]?.requestCount, 3);
      deepStrictEqual(merged.trajectories[0]?.requestBody.messages, restored);
      deepStrictEqual(records, before);
    });
  }

  it("handles feedback in a separate adjacent user message and preserves thinking completion", () => {
    const first = [calls, user([result("search", [reference])]), user([loaded])];
    const reply: OpenAiMessage = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "reason", signature: "sig" }, text("ready")],
    };
    const next = [calls, user([result("search", [disabled])]), reply, user([text("next")])];
    const merged = deriveTrajectoriesFromModelIoEntries(
      [{ ...record(first), response: { text: "ready" } }, record(next)],
      options,
    );
    equal(merged.trajectories.length, 1);
    deepStrictEqual(merged.trajectories[0]?.requestBody.messages, next);
  });

  for (const [label, blocks] of [
    ["unrelated user text", [loaded, text("question")]],
    ["another tool's result", [result("read", [reference]), loaded, text("question")]],
    ["unpaired result", [result("unknown", [reference]), loaded, text("question")]],
    ["failed search", [result("search", [reference], true), loaded, text("question")]],
    [
      "no-match search",
      [result("search", [text("No matching tools found")]), loaded, text("question")],
    ],
    ["text inside a result", [result("search", [reference, loaded]), text("question")]],
    [
      "feedback beyond the result count",
      [result("search", [reference, reference]), loaded, loaded, text("question")],
    ],
    ["feedback after ordinary text", [result("search", [reference]), text("question"), loaded]],
  ] satisfies Array<[string, unknown[]]>) {
    it(`does not hide changes to ${label}`, () => {
      const before = [calls, user(blocks)];
      equal(
        JSON.stringify(toolSearchComparisonMessages(before)).match(/Tool loaded\./gu)?.length,
        1,
      );
      const after = JSON.parse(JSON.stringify(before).replaceAll("Tool loaded.", "Changed text."));
      equal(
        deriveTrajectoriesFromModelIoEntries([record(before), record(after)], options).trajectories
          .length,
        2,
      );
    });
  }
});
