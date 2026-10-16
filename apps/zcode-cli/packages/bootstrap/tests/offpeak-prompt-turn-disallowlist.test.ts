import { describe, expect, it, vi } from "vitest";
import {
  buildTurnToolDisallowlist,
  resolveTurnOffPeakTaskId,
  startPromptTurn,
} from "../src/zcode-protocol-v4/commands/prompt-turn.js";
import { createFakeApp } from "./helpers/fake-zcode-app.js";
import type { SendInputOptions } from "../src/app/types.js";
import type { V4SessionRecordView } from "../src/zcode-protocol-v4/commands/types.js";

describe("buildTurnToolDisallowlist (off-peak, D49)", () => {
  it("automation 轮只隐藏三个 cron 写工具，不隐藏 OffPeakCreate（D49-3 反向断言）", () => {
    const tools = buildTurnToolDisallowlist({ automationId: "automation-1" });
    expect(tools).toEqual(expect.arrayContaining(["CronCreate", "CronUpdate", "CronDelete"]));
    expect(tools).not.toContain("OffPeakCreate");
    expect(tools).not.toContain("SendMessage");
    expect(tools).not.toContain("Workflow");
  });

  it("闲时轮隐藏 OffPeakCreate、SendMessage、Workflow（D49 + D52），OffPeakList 与 cron 工具不受影响", () => {
    const tools = buildTurnToolDisallowlist({ offPeakTaskId: "offpeak-1" });
    expect(tools).toEqual(["OffPeakCreate", "SendMessage", "Workflow"]);
  });

  it("闲时轮合并调用方已有 denylist（host 派发同时带 CronCreate，D45+D49）", () => {
    const tools = buildTurnToolDisallowlist({
      offPeakTaskId: "offpeak-1",
      toolDisallowlist: ["CronCreate"],
    });
    expect(tools).toEqual(
      expect.arrayContaining(["CronCreate", "OffPeakCreate", "SendMessage", "Workflow"]),
    );
    expect(tools).toHaveLength(4);
  });

  it("普通用户轮不追加任何隐藏", () => {
    expect(buildTurnToolDisallowlist({})).toBeUndefined();
  });
});

describe("resolveTurnOffPeakTaskId", () => {
  it("显式 offPeakTaskId 优先", () => {
    expect(resolveTurnOffPeakTaskId({ offPeakTaskId: "offpeak-1", inputId: "whatever" })).toBe(
      "offpeak-1",
    );
  });

  it("续跑 inputId 前缀兜底（offpeak-<uuid>:resume:<uuid>）", () => {
    expect(resolveTurnOffPeakTaskId({ inputId: "offpeak-abc:resume:def" })).toBe("offpeak-abc");
  });

  it("普通与 automation inputId 不误判", () => {
    expect(resolveTurnOffPeakTaskId({ inputId: "user-input-1" })).toBeUndefined();
    expect(resolveTurnOffPeakTaskId({ inputId: "automation-1:run:x" })).toBeUndefined();
    // 裸前缀（无 id 主体）不算有效身份。
    expect(resolveTurnOffPeakTaskId({ inputId: "offpeak-" })).toBeUndefined();
  });
});

describe("闲时 turn 清理与当前执行约束共存", () => {
  it.each(["completed", "queued", "rejected", "thrown"])(
    "%s 不残留 idle 身份，不丢 modelExecution/sharedContextRefs",
    async (outcome) => {
      const completion = Promise.withResolvers<void>();
      const sendInput = vi.fn(async () => {
        if (outcome === "thrown") throw new Error("admission failed");
        if (outcome === "rejected") return { kind: "rejected", reason: "no_active_turn" };
        if (outcome === "queued") return { kind: "queued", queueItemId: "q1" };
        return { kind: "started_turn", turnId: "turn-1", completion: completion.promise };
      });
      const record = {
        app: createFakeApp(undefined, {
          sendInput: sendInput as ReturnType<typeof createFakeApp>["sendInput"],
        }),
        workspace: { workspacePath: "/test/offpeak" },
        persistence: "immediate",
        traceContext: { traceId: "trace-offpeak", sessionId: "sess_test" },
        activeOffPeakTaskId: "previous-id",
      } as V4SessionRecordView;
      const modelExecution = { selectionScope: "execution" } satisfies NonNullable<
        SendInputOptions["modelExecution"]
      >;
      const sharedContextRefs: NonNullable<SendInputOptions["sharedContextRefs"]> = [];
      const run = startPromptTurn({ getRecord: () => record }, record, {
        content: "p",
        inputId: "input-1",
        offPeakTaskId: "current-id",
        modelExecution,
        sharedContextRefs,
      });
      if (outcome === "thrown" || outcome === "rejected") {
        await expect(run).rejects.toThrow();
      } else {
        const started = await run;
        if (outcome === "completed") {
          expect(record.activeOffPeakTaskId).toBe("current-id");
          completion.resolve();
          await started.completion;
        }
      }
      expect(sendInput).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          modelExecution,
          sharedContextRefs,
          offPeakTaskId: "current-id",
          toolDisallowlist: ["OffPeakCreate", "SendMessage", "Workflow"],
        }),
      );
      expect(record.activeOffPeakTaskId).toBe("previous-id");
      expect(record.activeBotDeliveryTarget).toBeUndefined();
    },
  );
});
