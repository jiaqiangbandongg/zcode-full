/**
 * submit profile（docs/execution-engine.md「Typed asks and `submit_result`」）的
 * 确定性集成测试：真实脚本 → 编译期 profile → 真实 driver + 真实 AgentRuntime（脚本化模型）。
 * 断言的是**模型面**：每次请求里 submit_result 的声明（typed / generic / 缺席）与 ask 尾注的形态，
 * 以及运行时守卫在静态 profile 错误时的两条路。
 */

import { describe, expect, it } from "vitest";
import { SUBMIT_RESULT_TOOL_NAME } from "@zcode/contracts";
import { GENERIC_SUBMIT_PROFILE, type ActorSubmitProfile } from "@zcode/dynamic-workflow";
import { TYPED_TOOL_EPILOGUE } from "../src/app/workflow-driver-helpers.js";
import { actorSubmitProfilesFor, runDriverScript } from "./workflow-driver.helpers.js";

const FULL_SCHEMA_EPILOGUE = "conforming to this JSON Schema";

const MONO_SCRIPT = [
  `interface Summary { title: string; points: string[] }`,
  `const a = agent("summarizer", "You summarize.");`,
  `const s = await a.ask<Summary>("Summarize the repo");`,
  `return s;`,
].join("\n");

const MULTI_SCRIPT = [
  `interface Summary { title: string; points: string[] }`,
  `interface Verdict { ok: boolean }`,
  `const a = agent("worker", "You do work.");`,
  `const s = await a.ask<Summary>("Summarize the repo");`,
  `const v = await a.ask<Verdict>("Judge " + s.title);`,
  `return [s, v];`,
].join("\n");

const UNTYPED_SCRIPT = [
  `const a = agent("talker", "You talk.");`,
  `const t = await a.ask("Say something");`,
  `return t;`,
].join("\n");

const SUMMARY = { title: "Repo", points: ["x"] };

function submitTool(log: { submitTools: unknown[] } | undefined, index = 0) {
  return (log?.submitTools[index] ?? undefined) as
    | { inputSchema: Record<string, unknown>; strict: boolean | undefined }
    | undefined;
}

describe("workflow driver — submit profile: mono subagent", () => {
  it("declares { result: schema } on the tool, marks it strict-eligible, and shrinks the epilogue", async () => {
    const profiles = actorSubmitProfilesFor(MONO_SCRIPT);
    expect(profiles.get("actor#1")?.kind).toBe("mono");

    const { settlement, modelCalls } = await runDriverScript(MONO_SCRIPT, {
      actorScripts: { "actor#1@1": [{ kind: "submit", result: SUMMARY }] },
      actorSubmitProfiles: "derive",
    });
    expect(settlement).toMatchObject({ status: "completed", artifact: SUMMARY });

    const tool = submitTool(modelCalls["actor#1@1"]);
    expect(tool).toBeDefined();
    expect(tool?.strict).toBe(true);
    const result = (tool?.inputSchema.properties as Record<string, Record<string, unknown>>).result;
    expect(result.type).toBe("object");
    expect(result.required).toEqual(["title", "points"]);
    expect(tool?.inputSchema.required).toEqual(["result"]);

    const prompt = modelCalls["actor#1@1"]?.prompts[0] ?? "";
    expect(prompt).toContain("Summarize the repo");
    expect(prompt).toContain("Standard for this result:");
    expect(prompt).toContain(TYPED_TOOL_EPILOGUE);
    expect(prompt).not.toContain(FULL_SCHEMA_EPILOGUE);
    // 质量尾注仍在，且在 typed 尾注之前。
    expect(prompt.indexOf("Standard for this result:")).toBeLessThan(
      prompt.indexOf(TYPED_TOOL_EPILOGUE),
    );
  });

  it("still repairs in-session against the engine's validator (strict is a guarantee, not the only defence)", async () => {
    const { settlement, modelCalls } = await runDriverScript(MONO_SCRIPT, {
      actorScripts: {
        "actor#1@1": [
          { kind: "submit", result: { title: 42 } },
          { kind: "submit", result: SUMMARY },
        ],
      },
      actorSubmitProfiles: "derive",
    });
    expect(settlement).toMatchObject({ status: "completed", artifact: SUMMARY });
    // 同一 turn 内两次模型请求（第一次被拒回 error tool_result），声明始终是 typed 的。
    expect(modelCalls["actor#1@1"]?.calls).toBe(2);
    expect(submitTool(modelCalls["actor#1@1"], 1)?.strict).toBe(true);
  });
});

describe("workflow driver — submit profile: generic and untyped subagents", () => {
  it("a subagent with two result types keeps the generic tool and the full schema epilogue", async () => {
    const profiles = actorSubmitProfilesFor(MULTI_SCRIPT);
    expect(profiles.get("actor#1")).toEqual(GENERIC_SUBMIT_PROFILE);

    const { settlement, modelCalls } = await runDriverScript(MULTI_SCRIPT, {
      actorScripts: {
        "actor#1@1": [
          { kind: "submit", result: SUMMARY },
          { kind: "submit", result: { ok: true } },
        ],
      },
      actorSubmitProfiles: "derive",
    });
    expect(settlement).toMatchObject({ status: "completed", artifact: [SUMMARY, { ok: true }] });
    const log = modelCalls["actor#1@1"];
    for (const index of [0, 1]) {
      const tool = submitTool(log, index);
      expect(tool?.strict).toBeUndefined();
      const result = (tool?.inputSchema.properties as Record<string, Record<string, unknown>>)
        .result;
      expect(result.type).toBeUndefined();
      expect(log?.prompts[index]).toContain(FULL_SCHEMA_EPILOGUE);
      expect(log?.prompts[index]).not.toContain(TYPED_TOOL_EPILOGUE);
    }
    // 两个 ask 之间工具声明逐字节不变（缓存不变式）。
    expect(submitTool(log, 0)?.inputSchema).toEqual(submitTool(log, 1)?.inputSchema);
  });

  it("an untyped-only subagent gets no submit_result at all and settles from its final text", async () => {
    const profiles = actorSubmitProfilesFor(UNTYPED_SCRIPT);
    expect(profiles.get("actor#1")).toEqual({ kind: "untyped" });

    const { settlement, modelCalls } = await runDriverScript(UNTYPED_SCRIPT, {
      actorScripts: { "actor#1@1": [{ kind: "text", text: "hello there" }] },
      actorSubmitProfiles: "derive",
    });
    expect(settlement).toMatchObject({ status: "completed", artifact: "hello there" });
    expect(modelCalls["actor#1@1"]?.toolNames[0]).not.toContain(SUBMIT_RESULT_TOOL_NAME);
    expect(submitTool(modelCalls["actor#1@1"])).toBeUndefined();
  });

  it("without a profile map every subagent is generic (the pre-2026-09-13 behaviour, byte for byte)", async () => {
    const { modelCalls } = await runDriverScript(MONO_SCRIPT, {
      actorScripts: { "actor#1@1": [{ kind: "submit", result: SUMMARY }] },
    });
    const tool = submitTool(modelCalls["actor#1@1"]);
    expect(tool?.strict).toBeUndefined();
    expect(modelCalls["actor#1@1"]?.prompts[0]).toContain(FULL_SCHEMA_EPILOGUE);
  });
});

describe("workflow driver — submit profile: runtime guard", () => {
  it("a mono declaration that does not match the ask's schema falls back to generic for that session", async () => {
    // 喂一份**错误**的静态 profile：声明的是 Verdict 的形状，实际 ask 要的是 Summary。
    const wrong: ActorSubmitProfile = {
      kind: "mono",
      schema: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
    };
    const { settlement, modelCalls } = await runDriverScript(MONO_SCRIPT, {
      actorScripts: { "actor#1@1": [{ kind: "submit", result: SUMMARY }] },
      actorSubmitProfiles: new Map([["actor#1", wrong]]),
    });
    expect(settlement).toMatchObject({ status: "completed", artifact: SUMMARY });
    // 模型看到的是换回来的通用声明 + 整份 schema 尾注，而不是错误的 typed 声明。
    const tool = submitTool(modelCalls["actor#1@1"]);
    expect(tool?.strict).toBeUndefined();
    const result = (tool?.inputSchema.properties as Record<string, Record<string, unknown>>).result;
    expect(result.type).toBeUndefined();
    expect(modelCalls["actor#1@1"]?.prompts[0]).toContain(FULL_SCHEMA_EPILOGUE);
  });

  it("a typed ask reaching an 'untyped' subagent fails that ask loudly instead of burning the nudge budget", async () => {
    const { settlement, modelCalls } = await runDriverScript(MONO_SCRIPT, {
      actorScripts: { "actor#1@1": [{ kind: "submit", result: SUMMARY }] },
      actorSubmitProfiles: new Map([["actor#1", { kind: "untyped" }]]),
    });
    expect(settlement.status).toBe("errored");
    const message = settlement.status === "errored" ? settlement.error.message : "";
    expect(message).toContain('"untyped"');
    expect(message).toContain("ask#1@1");
    // 一次模型请求都没发：守卫在派发 turn 之前就把 ask 判失败了。
    expect(modelCalls["actor#1@1"]?.calls ?? 0).toBe(0);
  });
});
