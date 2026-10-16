/**
 * 确定性模型侧错误让整个 run 停下（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Terminal states」）：driver 经
 * `stopRun(ProviderStop)` 报上来，引擎不结算节点，脚本永远看不到它（`agent()` 不 reject 成模型
 * 失败），在飞的兄弟 ask 一律 abort，结算 stopped(provider) 且 failure 落 journal（可 resume）。
 */

import { describe, expect, it } from "vitest";
import { WorkflowError } from "@zcode/dynamic-workflow";
import { runScript } from "./helpers.js";

const PROVIDER_STOP = new WorkflowError("ProviderStop", "Sign-in to BigModel expired.", {
  providerStop: {
    kind: "auth",
    reason: "auth_failed",
    providerId: "account:bigmodel-coding-plan",
    modelId: "GLM-5.3",
    providerCode: "1006",
    subagent: "ask#1@1",
    rawMessage: "[1006] token expired",
  },
});

describe("provider stop 过界", () => {
  it("脚本的 try/catch 拦不到它：run 以 stopped(provider) 停下，兄弟 ask 被 abort", async () => {
    const script = [
      'const a = agent("a", "You do things.");',
      'const b = agent("b", "You do things.");',
      "try {",
      '  await Promise.all([a.ask("go"), b.ask("go")]);',
      "} catch (e) {",
      '  return "caught";',
      "}",
      'return "done";',
    ].join("\n");

    const { settlement, journal, driver } = await runScript(script, {
      asks: {
        "ask#1": () => ({ type: "stop-run", error: PROVIDER_STOP }),
        // 兄弟 ask 永不应答：只有 run 级 abort 能把它收掉。
        "ask#2": () => [],
      },
    });

    expect(settlement).toEqual({ status: "stopped", reason: "provider", error: PROVIDER_STOP });
    const run = journal.getRun("run");
    expect(run?.status).toBe("stopped");
    expect(run?.stopReason).toBe("provider");
    expect(run?.failure).toEqual(PROVIDER_STOP.toJSON());
    // 两个在飞 ask 都被 driver 侧取消，节点停在准入时的 running 记录（resume 可据此重跑）。
    expect(driver.cancels.map((c) => c.siteId).sort()).toEqual(["ask#1", "ask#2"]);
    expect(journal.getNode("run", "ask#1", 1)?.status).toBe("running");
    expect(journal.getNode("run", "ask#2", 1)?.status).toBe("running");
    const settled = driver.eventsOfType("run-settled");
    expect(settled).toEqual([
      {
        type: "run-settled",
        status: "stopped",
        stopReason: "provider",
        error: PROVIDER_STOP.toJSON(),
      },
    ]);
  });
});
