import { describe, expect, it } from "vitest";
import type { SessionId } from "@zcode/contracts";
import type { AgentProfile } from "../src/subagent/profile.js";
import {
  setup,
  usage,
  initial,
  done,
  spawn,
  send,
  assertProfile,
} from "./subagent-profile-scenario.js";

describe("single-field profile refresh through parent tools", () => {
  it.each(["reasoning", "prompt", "tools"] as const)(
    "updates only %s for completed resume and new spawn without changing model",
    async (field) => {
      const scenario = setup();
      await scenario.turn([spawn("ORIGINAL_INPUT")]);
      const original = (await scenario.spawned())[0]!;
      await scenario.waitCompleted(original.agentId, 1);
      const history = structuredClone(
        await scenario.store.messages({ sessionID: original.childSessionId }),
      );
      const timeline = () =>
        scenario.store
          .messages({ sessionID: original.childSessionId })
          .then((messages) =>
            messages
              .flatMap((m) => m.parts)
              .filter((part) => part.type === "timeline" && part.timelineType === "model_change"),
          );
      const previousTimeline = await timeline();
      const updated = initial();
      if (field === "reasoning") updated.modelSelection!.options!.reasoningLevel = "high";
      if (field === "prompt") updated.systemPrompt = "PROFILE_CHANGED";
      if (field === "tools") updated.tools = ["Grep"];
      scenario.update(updated);
      await scenario.turn([send(original.agentId, "RESUME_INPUT")]);
      await scenario.waitCompleted(original.agentId, 2);
      const resumed = scenario.children.at(-1)!;
      assertProfile(resumed, updated);
      expect(resumed.sessionId).toBe(original.childSessionId);
      expect(JSON.stringify(resumed.request.messages)).toContain("ORIGINAL_INPUT");
      expect(JSON.stringify(resumed.request.messages)).toContain("RESUME_INPUT");
      if (field === "prompt")
        expect(JSON.stringify(resumed.request.messages)).not.toContain("PROFILE_ORIGINAL");
      expect(
        (await scenario.store.messages({ sessionID: original.childSessionId })).slice(
          0,
          history.length,
        ),
      ).toEqual(history);
      const selection = (
        await scenario.store.sessionEntries!({
          sessionID: original.childSessionId,
          type: "runtime/model_selection",
        })
      ).at(-1);
      expect(selection?.data).toEqual(updated.modelSelection);
      expect((await timeline()).length - previousTimeline.length).toBe(
        field === "reasoning" ? 1 : 0,
      );
      if (field === "reasoning")
        expect((await timeline()).at(-1)).toMatchObject({
          fromModel: { modelId: "fixed", options: { reasoningLevel: "low" } },
          toModel: { modelId: "fixed", options: { reasoningLevel: "high" } },
        });
      await scenario.turn([spawn("NEW_SPAWN")]);
      assertProfile(scenario.children.at(-1)!, updated);
      expect(scenario.children.at(-1)!.sessionId).not.toBe(original.childSessionId);
      // resume 也发布 SubagentSpawned，身份去重后才是实际 child 数量。
      expect(new Set((await scenario.spawned()).map((event) => event.childSessionId)).size).toBe(2);
      expect(new Set((await scenario.spawned()).map((event) => event.agentId)).size).toBe(2);
    },
  );

  it("keeps running child messages on its launch profile across parent turns, then refreshes terminal resume", async () => {
    const blocked = Promise.withResolvers<void>();
    const began = Promise.withResolvers<void>();
    let runningId: SessionId | undefined,
      runningCalls = 0;
    const scenario = setup(async (record) => {
      runningId ??= record.sessionId;
      if (record.sessionId === runningId && ++runningCalls === 1) {
        began.resolve();
        await blocked.promise;
        // 现有 Read 工具形成下一次模型请求；缺文件结果也经过正常工具结果链路。
        return {
          finishReason: "tool-calls",
          text: "",
          usage,
          toolCalls: [
            {
              id: "read_running",
              name: "Read",
              input: { file_path: "/missing-profile-refresh-fixture" },
            },
          ],
        };
      }
      return done();
    });
    try {
      await scenario.turn([spawn("RUNNING_ORIGINAL", true)]);
      await began.promise;
      const original = (await scenario.spawned())[0]!;
      const updated: AgentProfile = {
        ...initial(),
        systemPrompt: "PROFILE_NEXT_PARENT",
        tools: ["Grep"],
        modelSelection: {
          providerId: "custom",
          modelId: "replacement",
          options: { reasoningLevel: "high" },
        },
      };
      scenario.update(updated);
      await scenario.turn([send(original.agentId, "RUNNING_MESSAGE"), spawn("NEXT_PARENT_CHILD")]);
      expect(scenario.children.filter((r) => r.sessionId === original.childSessionId)).toHaveLength(
        1,
      );
      assertProfile(
        scenario.children.find((r) => r.sessionId !== original.childSessionId)!,
        updated,
      );
      blocked.resolve();
      await scenario.waitCompleted(original.agentId, 1);
      const continuation = scenario.children
        .filter((r) => r.sessionId === original.childSessionId)
        .at(-1)!;
      assertProfile(continuation, initial());
      expect(JSON.stringify(continuation.request.messages)).toContain("RUNNING_MESSAGE");
      expect(JSON.stringify(continuation.request.messages)).not.toContain(updated.systemPrompt);
      await scenario.turn([send(original.agentId, "TERMINAL_MESSAGE")]);
      await scenario.waitCompleted(original.agentId, 2);
      const resumed = scenario.children.at(-1)!;
      assertProfile(resumed, updated);
      expect(resumed.sessionId).toBe(original.childSessionId);
      expect(JSON.stringify(resumed.request.messages)).toContain("RUNNING_ORIGINAL");
      expect(JSON.stringify(resumed.request.messages)).toContain("TERMINAL_MESSAGE");
    } finally {
      blocked.resolve();
    }
  });
});
