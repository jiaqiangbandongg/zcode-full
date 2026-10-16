import { describe, expect, it } from "vitest";
import {
  GET_WORKFLOW_RUN_TOOL_NAME,
  GetWorkflowRunOutputSchema,
  type DynamicWorkflowRunDetail,
  type DynamicWorkflowRunPort,
  type GetWorkflowRunOutput,
} from "@zcode/contracts";
import { PermissionService } from "../src/permission/service.js";
import { resolveRuntimePermissionCapability } from "../src/tool/executor/permission-capability.js";
import { getWorkflowRunToolEntry } from "../src/tool/handlers/get-workflow-run.js";
import { buildWorkflowRunSummary } from "../src/tool/handlers/get-workflow-run-summary.js";
import { registerBuiltInTools } from "../src/tool/handlers/index.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { expectV2CommonContract } from "./tool-contract-assertions.js";
import type { ToolExecutionContext, ToolHandlerFailure } from "../src/tool/types.js";

/** 快照时刻：run 的 updatedAt 之后 40 秒，createdAt 之后 5m 40s。所有年龄都对它算。 */
const NOW = Date.UTC(2026, 7, 21, 9, 5, 40);

const RUNNING_DETAIL: DynamicWorkflowRunDetail = {
  runId: "dwfrun-running",
  label: "nightly triage",
  labelSource: "name",
  status: "running",
  ownedByThisSession: true,
  createdAt: Date.UTC(2026, 7, 21, 9, 0, 0),
  updatedAt: Date.UTC(2026, 7, 21, 9, 5, 0),
  usage: {
    spentTokens: 1_204,
    nodesObserved: 3,
    nodesRunning: 1,
    nodesCompleted: 2,
    nodesFailed: 0,
  },
  actors: [
    { siteId: "agent#1", ordinal: 1, name: "judge" },
    { siteId: "agent#2", ordinal: 1 },
  ],
  logTail: [
    { sequence: 11, message: "collected the failing specs", at: Date.UTC(2026, 7, 21, 9, 0, 50) },
    { sequence: 14, message: "asked the judge", at: Date.UTC(2026, 7, 21, 9, 4, 40) },
  ],
  subagents: [
    {
      siteId: "agent#1",
      ordinal: 1,
      name: "judge",
      state: "executing",
      phaseName: "judge",
      currentAsk: {
        siteId: "ask#4",
        ordinal: 1,
        actorSeq: 2,
        instructionsHead: "Judge specs 1-7 for flakiness; report real failures with evidence",
        startedAt: Date.UTC(2026, 7, 21, 9, 4, 28),
        turn: 4,
        toolCalls: 7,
        lastTool: {
          name: "Read",
          target: "packages/net/retry.spec.ts",
          at: Date.UTC(2026, 7, 21, 9, 5, 32),
        },
      },
      stepsSettled: 1,
      stepsFailed: 0,
      tokens: 5_100,
      lastProgressAt: Date.UTC(2026, 7, 21, 9, 5, 32),
    },
    {
      siteId: "agent#2",
      ordinal: 1,
      // 活着的 run 上端口从不发 `done`（那是终态词）：歇着的子代理是 `idle`。
      state: "idle",
      phaseName: "collect",
      stepsSettled: 1,
      stepsFailed: 0,
      tokens: 2_130,
    },
  ],
  health: {
    lastProgressAt: Date.UTC(2026, 7, 21, 9, 5, 0),
    consecutiveFailures: 0,
    cachedSteps: 0,
    pendingQuestionsKnown: true,
  },
};

/**
 * 模型面的输入是**工具输出**，不是端口详情：`summary` 与 `generatedAt` 由 handler 铸出，
 * 格式器只是它们的纯函数。钉住一个固定的 `generatedAt`，整段文本（含每一个「多久以前」）
 * 因此可以逐字断言。
 */
const RUNNING_OUTPUT: GetWorkflowRunOutput = {
  ...(RUNNING_DETAIL as unknown as Omit<GetWorkflowRunOutput, "summary" | "generatedAt">),
  generatedAt: NOW,
  summary:
    "Running for 5m 40s. 2 of 3 dispatched steps settled, 1 running (1 executing). Last progress 40s ago.",
};

/** 只实现 `getRunDetail` 的桩端口；其余成员被触达即说明接线跑偏。 */
function stubDetailPort(
  details: Readonly<Record<string, DynamicWorkflowRunDetail>>,
): DynamicWorkflowRunPort {
  const unreachable = (name: string) => () => {
    throw new Error(`stubDetailPort.${name} 不应被 GetWorkflowRun handler 触及`);
  };
  return {
    submit: unreachable("submit"),
    getTask: unreachable("getTask"),
    waitForTask: unreachable("waitForTask"),
    cancel: unreachable("cancel"),
    listEvents: unreachable("listEvents"),
    listRuns: unreachable("listRuns"),
    async getRunDetail(runId: string) {
      return details[runId];
    },
  } as unknown as DynamicWorkflowRunPort;
}

function contextWith(port?: DynamicWorkflowRunPort): ToolExecutionContext {
  return {
    abortSignal: new AbortController().signal,
    sessionId: "sess_get_run" as never,
    toolCallId: "toolu_get_run",
    traceId: "trace_get_run" as never,
    workingDirectory: "/workspace/project",
    workspaceRoot: "/workspace/project",
    ...(port === undefined ? {} : { dynamicWorkflowRunPort: port }),
  } as ToolExecutionContext;
}

async function call(runId: string, port?: DynamicWorkflowRunPort): Promise<Record<string, unknown>> {
  return (await getWorkflowRunToolEntry.handler({ run_id: runId }, contextWith(port))) as Record<
    string,
    unknown
  >;
}

function asFailure(output: unknown): ToolHandlerFailure {
  const failure = output as ToolHandlerFailure;
  expect(failure.result).toBe(false);
  return failure;
}

/**
 * 输出 = 端口详情逐字段搬过来，外加 handler 自己铸的两件事：那一句摘要，和这次快照的时刻。
 * 时钟是真的 `Date.now()`，所以这里只钉形状不钉值——值的确定性由格式器与摘要的单测钉。
 */
function expectMirrorsDetail(output: Record<string, unknown>, detail: DynamicWorkflowRunDetail): void {
  expect(GetWorkflowRunOutputSchema.parse(output)).toEqual({
    ...detail,
    summary: expect.any(String),
    generatedAt: expect.any(Number),
  });
}

describe("GetWorkflowRun handler — capability and identity", () => {
  it("returns the same business failure for an absent port and an absent method", async () => {
    const portWithoutMethod = {
      async submit() {
        throw new Error("unreachable");
      },
    } as unknown as DynamicWorkflowRunPort;

    const withoutPort = asFailure(await call("dwfrun-x"));
    const withoutMethod = asFailure(await call("dwfrun-x", portWithoutMethod));

    expect(withoutPort.message).toContain("workflow_introspection_unavailable");
    expect(withoutMethod).toEqual(withoutPort);
  });

  // 未知 runId 是一个**结构化失败**而不是一个空对象：后者会让模型以为这个 run 存在但没内容。
  it("fails with run_not_found for an unknown run id", async () => {
    const failure = asFailure(await call("dwfrun-nope", stubDetailPort({})));

    expect(failure.message).toContain("run_not_found");
    expect(failure.message).toContain("dwfrun-nope");
    // 能力缺席与 run 未知必须可分辨。
    expect(failure.errorCode).not.toBe(asFailure(await call("dwfrun-nope")).errorCode);
  });
});

describe("GetWorkflowRun handler — running snapshot", () => {
  it("gives progress, actors and the log tail, with neither result nor error", async () => {
    const output = await call(
      "dwfrun-running",
      stubDetailPort({ "dwfrun-running": RUNNING_DETAIL }),
    );

    expectMirrorsDetail(output, RUNNING_DETAIL);
    expect("result" in output).toBe(false);
    expect("error" in output).toBe(false);
  });

  // 每 run 的并发上界（docs/dynamic-workflow/concurrency.md「Two bounds on a run」）。端口只在不等于
  // 默认并发时给这个字段，所以「无则缺席」在读面上是构造成立的，不是这里再判一次。
  it("carries the run's own concurrency bound when it has one", async () => {
    const detail: DynamicWorkflowRunDetail = { ...RUNNING_DETAIL, maxConcurrency: 3 };
    const output = await call("dwfrun-running", stubDetailPort({ "dwfrun-running": detail }));

    expect(output.maxConcurrency).toBe(3);
    expectMirrorsDetail(output, detail);
  });

  it("omits the bound entirely for a run at the machine default", async () => {
    const output = await call(
      "dwfrun-running",
      stubDetailPort({ "dwfrun-running": RUNNING_DETAIL }),
    );

    expect("maxConcurrency" in output).toBe(false);
  });

  // 每 run 的子代理模型（docs/dynamic-workflow/launch.md）。与并发上界同规「无则缺席」：
  // 继承会话模型的 run 没有可说的。
  it("carries the run's own subagent model when it chose one", async () => {
    const detail: DynamicWorkflowRunDetail = {
      ...RUNNING_DETAIL,
      subagentModel: "bigmodel/GLM-4.6$high",
    };
    const output = await call("dwfrun-running", stubDetailPort({ "dwfrun-running": detail }));

    expect(output.subagentModel).toBe("bigmodel/GLM-4.6$high");
    expectMirrorsDetail(output, detail);
  });

  it("omits the model entirely for a run on the session model", async () => {
    const output = await call(
      "dwfrun-running",
      stubDetailPort({ "dwfrun-running": RUNNING_DETAIL }),
    );

    expect("subagentModel" in output).toBe(false);
  });

  // 本 run 的脚本文件（docs/dynamic-workflow/launch.md「Script files」）。端口给绝对路径（run
  // 身份的一部分），模型面给工作区相对写法——模型接下来要 Edit 这个文件，而那是它在别处
  // 读写文件时用的那一种路径。
  it("rewrites the run's script file as a workspace-relative path", async () => {
    const detail: DynamicWorkflowRunDetail = {
      ...RUNNING_DETAIL,
      scriptPath: "/workspace/project/.zcode/workflow-drafts/audit.dwf.ts",
    };
    const output = await call("dwfrun-running", stubDetailPort({ "dwfrun-running": detail }));

    expect(output.scriptPath).toBe(".zcode/workflow-drafts/audit.dwf.ts");
  });

  it("keeps a script file outside the working directory absolute", async () => {
    const detail: DynamicWorkflowRunDetail = {
      ...RUNNING_DETAIL,
      scriptPath: "/elsewhere/shared/audit.dwf.ts",
    };
    const output = await call("dwfrun-running", stubDetailPort({ "dwfrun-running": detail }));

    expect(output.scriptPath).toBe("/elsewhere/shared/audit.dwf.ts");
    expectMirrorsDetail(output, detail);
  });

  it("omits the script file entirely for a run that recorded none", async () => {
    const output = await call(
      "dwfrun-running",
      stubDetailPort({ "dwfrun-running": RUNNING_DETAIL }),
    );

    expect("scriptPath" in output).toBe(false);
  });

  it("carries the possiblyInterrupted annotation", async () => {
    const detail: DynamicWorkflowRunDetail = {
      ...RUNNING_DETAIL,
      ownedByThisSession: false,
      possiblyInterrupted: true,
    };
    const output = await call("dwfrun-running", stubDetailPort({ "dwfrun-running": detail }));

    expectMirrorsDetail(output, detail);
  });
});

describe("GetWorkflowRun handler — the situation cross-section", () => {
  it("carries the phase table, the roster and health across the boundary unchanged", async () => {
    const detail: DynamicWorkflowRunDetail = {
      ...RUNNING_DETAIL,
      phases: [
        { name: "collect", state: "done", rounds: 1, nodesSettled: 2, nodesRunning: 0, enteredAt: 1, exitedAt: 2 },
        { name: "judge", state: "current", rounds: 1, nodesSettled: 1, nodesRunning: 1, enteredAt: 2 },
      ],
    };
    const output = await call("dwfrun-running", stubDetailPort({ "dwfrun-running": detail }));

    expectMirrorsDetail(output, detail);
    expect(output.subagents).toHaveLength(2);
  });

  // 一个 actor 都没有的 run 是空数组，不是缺席：「有几个子代理」永远有答案，而 0 就是那个答案。
  it("keeps an empty roster as an empty array and an absent phase table absent", async () => {
    const detail: DynamicWorkflowRunDetail = { ...RUNNING_DETAIL, subagents: [] };
    const output = await call("dwfrun-running", stubDetailPort({ "dwfrun-running": detail }));

    expect(output.subagents).toEqual([]);
    expect("phases" in output).toBe(false);
  });

  it("clamps the roster at 64 rows and says it clamped", async () => {
    const one = RUNNING_DETAIL.subagents[1]!;
    const many = Array.from({ length: 70 }, (_, index) => ({ ...one, ordinal: index + 1 }));
    const output = await call(
      "dwfrun-many",
      stubDetailPort({ "dwfrun-many": { ...RUNNING_DETAIL, subagents: many } }),
    );

    expect(output.subagents).toHaveLength(64);
    expect(output.subagentsTruncated).toBe(true);
    expect(GetWorkflowRunOutputSchema.safeParse(output).success).toBe(true);

    const exact = await call(
      "dwfrun-exact",
      stubDetailPort({ "dwfrun-exact": { ...RUNNING_DETAIL, subagents: many.slice(0, 64) } }),
    );
    expect("subagentsTruncated" in exact).toBe(false);
  });

  // 终态 run 没有残留行是常态；`leftover_running=0` 读起来像一件发生过的事。
  it("drops a zero leftover count instead of reporting it", async () => {
    const detail: DynamicWorkflowRunDetail = {
      ...RUNNING_DETAIL,
      status: "stopped",
      stopReason: "interrupted",
      health: { ...RUNNING_DETAIL.health, leftoverRunning: 0 },
    };
    const output = await call("dwfrun-left", stubDetailPort({ "dwfrun-left": detail }));

    expect((output.health as Record<string, unknown>).leftoverRunning).toBeUndefined();
    expect(GetWorkflowRunOutputSchema.safeParse(output).success).toBe(true);
  });

  // turn / toolCalls 缺席读作「不知道」：老 journal 没有 node-progress，handler 不得补 0。
  it("never fabricates progress readings a journal does not have", async () => {
    const detail: DynamicWorkflowRunDetail = {
      ...RUNNING_DETAIL,
      subagents: [
        {
          siteId: "agent#1",
          ordinal: 1,
          state: "executing",
          currentAsk: { siteId: "ask#1", ordinal: 0 },
          stepsSettled: 0,
          stepsFailed: 0,
          tokens: 0,
        },
      ],
    };
    const output = await call("dwfrun-old", stubDetailPort({ "dwfrun-old": detail }));
    const ask = (output.subagents as Record<string, unknown>[])[0]!.currentAsk as Record<string, unknown>;

    for (const key of ["turn", "toolCalls", "lastTool", "startedAt", "actorSeq", "instructionsHead"]) {
      expect(key in ask).toBe(false);
    }
  });

  // 一次调用一把尺：摘要与模型面的每一个年龄都对这一个读数算。
  it("stamps the snapshot with one clock and assembles the summary from it", async () => {
    const before = Date.now();
    const output = await call("dwfrun-running", stubDetailPort({ "dwfrun-running": RUNNING_DETAIL }));

    expect(output.generatedAt as number).toBeGreaterThanOrEqual(before);
    expect(output.generatedAt as number).toBeLessThanOrEqual(Date.now());
    expect(String(output.summary)).toContain("dispatched steps settled");
    expect(String(output.summary).length).toBeLessThanOrEqual(400);
  });
});

describe("GetWorkflowRun handler — terminal artifact", () => {
  function completedWith(result: unknown): DynamicWorkflowRunDetail {
    return { ...RUNNING_DETAIL, status: "completed", result };
  }

  it("passes a string artifact through verbatim", async () => {
    const output = await call(
      "dwfrun-done",
      stubDetailPort({ "dwfrun-done": completedWith("all specs green") }),
    );

    expect(output.result).toBe("all specs green");
  });

  // 序列化走 core 的唯一实现（serializeWorkflowArtifact），与完成通知和 TaskOutput 同一段文本。
  it("pretty-prints a structured artifact exactly like the completion notification", async () => {
    const output = await call(
      "dwfrun-done",
      stubDetailPort({ "dwfrun-done": completedWith({ verdict: "ship", failures: [] }) }),
    );

    expect(output.result).toBe('{\n  "verdict": "ship",\n  "failures": []\n}');
    expect(GetWorkflowRunOutputSchema.safeParse(output).success).toBe(true);
  });

  it("keeps null as a legal artifact and omits the field for undefined", async () => {
    const nullResult = await call(
      "dwfrun-null",
      stubDetailPort({ "dwfrun-null": completedWith(null) }),
    );
    const voidResult = await call(
      "dwfrun-void",
      stubDetailPort({ "dwfrun-void": { ...RUNNING_DETAIL, status: "completed" } }),
    );

    expect(nullResult.result).toBe("null");
    expect("result" in voidResult).toBe(false);
  });
});

// ⚠ 术语：上一个 describe 的 "artifact" 是脚本的**顶层返回值**（进 `result`）；这一个是
// 脚本经 `artifact.*` **发布给用户看的产出**（进 `artifacts`）。两者在同一份输出里并列。
// 见 docs/dynamic-workflow/authoring.md「Artifacts: what the user keeps」。
describe("GetWorkflowRun handler — published artifacts", () => {
  const AUDIT = {
    id: "audit",
    kind: "file" as const,
    title: "审计报告",
    contentType: "application/pdf",
    sourcePath: "out/audit.pdf",
    version: 2,
    itemCount: 0,
    versions: [
      { version: 1, publishedAt: 1, bytes: 10, uri: "zcode-artifact://one" },
      { version: 2, publishedAt: 2, bytes: 4_096, uri: "zcode-artifact://two" },
    ],
  };
  const PERF = {
    id: "perf",
    kind: "chart" as const,
    version: 1,
    itemCount: 12,
    spec: { x: { field: "round" }, y: { field: "ms" } },
    versions: [{ version: 1, publishedAt: 3 }],
  };

  it("hoists the latest version's bytes and drops uri / spec / versions from the model face", async () => {
    const output = await call(
      "dwfrun-art",
      stubDetailPort({
        "dwfrun-art": { ...RUNNING_DETAIL, status: "completed", artifacts: [AUDIT, PERF] },
      }),
    );

    expect(output.artifacts).toEqual([
      {
        id: "audit",
        kind: "file",
        title: "审计报告",
        version: 2,
        contentType: "application/pdf",
        // 最新版的字节数，不是第一版的。
        bytes: 4_096,
        sourcePath: "out/audit.pdf",
        itemCount: 0,
      },
      { id: "perf", kind: "chart", version: 1, itemCount: 12 },
    ]);
    // `uri` 刻意不出：模型读不了 tool-artifact store。`spec` / `versions` 也是 UI 的事。
    expect(JSON.stringify(output.artifacts)).not.toContain("zcode-artifact://");
    expect(JSON.stringify(output.artifacts)).not.toContain("round");
    expect(GetWorkflowRunOutputSchema.safeParse(output).success).toBe(true);
  });

  // 任意状态都附：一个还在跑的 run 也可能已经交付了第一张图。
  it("carries artifacts on a running run too, and omits the field when there are none", async () => {
    const running = await call(
      "dwfrun-art-running",
      stubDetailPort({ "dwfrun-art-running": { ...RUNNING_DETAIL, artifacts: [PERF] } }),
    );
    expect(running.status).toBe("running");
    expect(running.artifacts).toHaveLength(1);

    // 零件 / 端口不发这个键 ⇒ 整字段缺席（空数组读起来像「跑过但没产出」）。
    const none = await call("dwfrun-running", stubDetailPort({ "dwfrun-running": RUNNING_DETAIL }));
    expect("artifacts" in none).toBe(false);
    const empty = await call(
      "dwfrun-art-empty",
      stubDetailPort({ "dwfrun-art-empty": { ...RUNNING_DETAIL, artifacts: [] } }),
    );
    expect("artifacts" in empty).toBe(false);
  });

  it("bounds the section at 32 (= ARTIFACT_CAPS.maxArtifactsPerRun)", async () => {
    const many = Array.from({ length: 40 }, (_, index) => ({
      id: `a${index + 1}`,
      kind: "markdown" as const,
      version: 1,
      itemCount: 0,
      versions: [{ version: 1, publishedAt: 1, bytes: 8 }],
    }));
    const output = await call(
      "dwfrun-art-many",
      stubDetailPort({ "dwfrun-art-many": { ...RUNNING_OUTPUT, artifacts: many } }),
    );
    expect(output.artifacts).toHaveLength(32);
  });

  it("renders one line per artifact after <result> / <error>, in the notification's format", () => {
    const content = String(
      getWorkflowRunToolEntry.formatModelContent?.({
        ...RUNNING_OUTPUT,
        status: "completed",
        result: "shipped",
        artifacts: [
          {
            id: "audit",
            kind: "file",
            title: "审计报告",
            version: 2,
            contentType: "application/pdf",
            bytes: 4_096,
            sourcePath: "out/audit.pdf",
            itemCount: 0,
          },
          { id: "perf", kind: "chart", version: 1, itemCount: 12 },
        ],
      }),
    );

    expect(content).toContain('<artifacts count="2">');
    // 与完成通知逐字共用一个格式器：两处的读者是同一个模型。
    expect(content).toContain("- audit (file, v2, application/pdf, 4096 bytes): 审计报告");
    expect(content).toContain("- perf (chart, v1, 12 items)");
    // 排在 result 之后：run 的收场先读，交付物清单是索引。
    expect(content.indexOf("<artifacts")).toBeGreaterThan(content.indexOf("<result>"));
  });

  it("keeps the primary flag on the model face and marks its line right after the kind", async () => {
    const REPORT = {
      id: "report",
      kind: "markdown" as const,
      title: "审计报告",
      description: "结论与修复建议",
      version: 1,
      itemCount: 0,
      primary: true as const,
      versions: [{ version: 1, publishedAt: 4, bytes: 2_048, primary: true as const }],
    };
    const output = await call(
      "dwfrun-art-primary",
      stubDetailPort({
        "dwfrun-art-primary": {
          ...RUNNING_OUTPUT,
          status: "completed",
          // The port already orders the deliverable first; the handler keeps that order.
          artifacts: [REPORT, PERF],
        },
      }),
    );
    expect(output.artifacts).toEqual([
      { id: "report", kind: "markdown", title: "审计报告", version: 1, bytes: 2_048, itemCount: 0, primary: true },
      { id: "perf", kind: "chart", version: 1, itemCount: 12 },
    ]);
    expect(GetWorkflowRunOutputSchema.safeParse(output).success).toBe(true);

    const content = String(
      getWorkflowRunToolEntry.formatModelContent?.({
        ...RUNNING_OUTPUT,
        status: "completed",
        artifacts: output.artifacts!,
      }),
    );
    expect(content).toContain("- report (markdown, primary, v1, 2048 bytes): 审计报告");
    expect(content).toContain("- perf (chart, v1, 12 items)");
  });

  it("omits the block when there are no artifacts", () => {
    expect(String(getWorkflowRunToolEntry.formatModelContent?.(RUNNING_OUTPUT))).not.toContain(
      "<artifacts",
    );
  });

  // 描述文案里的那一句：产物已经在用户面前，按标题引用而不是复述内容。
  it("tells the model in the tool description not to paste artifact contents", () => {
    expect(getWorkflowRunToolEntry.metadata.description).toContain(
      "ALREADY shown to them as cards",
    );
    expect(getWorkflowRunToolEntry.metadata.description).toContain(
      "The one marked `primary` is the deliverable",
    );
  });
});

describe("GetWorkflowRun handler — terminal failure", () => {
  it("passes the Interrupted code and the stop reason through so the model can tell a dead process from a bad script", async () => {
    const detail: DynamicWorkflowRunDetail = {
      ...RUNNING_DETAIL,
      status: "stopped",
      stopReason: "interrupted",
      error: {
        code: "Interrupted",
        message: "dynamic workflow run dwfrun-dead was interrupted",
      },
    };
    const output = await call("dwfrun-dead", stubDetailPort({ "dwfrun-dead": detail }));

    expect(output.error).toEqual(detail.error);
    expect(output.stopReason).toBe("interrupted");
    expectMirrorsDetail(output, detail);
  });

  it("carries an errored run's failure", async () => {
    const detail: DynamicWorkflowRunDetail = {
      ...RUNNING_DETAIL,
      status: "errored",
      error: { code: "DriverError", message: "the script threw" },
    };
    const output = await call("dwfrun-errored", stubDetailPort({ "dwfrun-errored": detail }));

    expect(output.status).toBe("errored");
    expect("stopReason" in output).toBe(false);
    expect(output.error).toEqual(detail.error);
  });

  // provider 停下（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md）：结构化明细原样过界，模型面据它选文案。
  it("carries a provider stop's structured details", async () => {
    const detail: DynamicWorkflowRunDetail = {
      ...RUNNING_DETAIL,
      status: "stopped",
      stopReason: "provider",
      error: {
        code: "ProviderStop",
        message: "Subagent turn failed: [1006] token expired",
        providerStop: {
          kind: "auth",
          reason: "auth_failed",
          providerId: "account:bigmodel-coding-plan",
          providerLabel: "BigModel",
          modelId: "GLM-5.3",
          providerCode: "1006",
          subagent: "verify@2",
          phase: "Verify",
          rawMessage: "[1006] token expired",
        },
      },
    };
    const output = await call("dwfrun-stop", stubDetailPort({ "dwfrun-stop": detail }));

    expect(output.stopReason).toBe("provider");
    expect(output.error).toEqual(detail.error);
    expectMirrorsDetail(output, detail);
  });
});

describe("GetWorkflowRun model content", () => {
  it("renders the common cross-section, usage, actors and log tail as blocks", () => {
    const content = String(getWorkflowRunToolEntry.formatModelContent?.(RUNNING_OUTPUT));

    expect(content).toContain("<run_id>dwfrun-running</run_id>");
    expect(content).toContain('<label source="name">nightly triage</label>');
    expect(content).toContain("<status>running</status>");
    expect(content).toContain("<owned_by_this_session>true</owned_by_this_session>");
    // 时刻写两遍：可核对的 ISO，加上读者真正要的那个量（相对 generatedAt 的年龄）。
    expect(content).toContain("<updated_at>2026-08-21T09:05:00.000Z (40s ago)</updated_at>");
    expect(content).toContain("<created_at>2026-08-21T09:00:00.000Z (5m 40s ago)</created_at>");
    expect(content).toContain("<usage>spent_tokens=1204");
    expect(content).not.toContain("budget");
    expect(content).toContain("nodes_observed=3");
    expect(content).toContain("nodes_running=1");
    // 花名册取代了原先那张「只有身份」的 actors 表：名字在前，地址与相位随后。
    expect(content).toContain("judge  agent#1@1  executing");
    expect(content).toContain("agent#2@1");
    expect(content).toContain("[11]  4m 50s ago  collected the failing specs");
    expect(content).not.toContain("possibly_interrupted");
    expect(content).not.toContain("<result>");
    expect(content).not.toContain("<error");
  });

  // 一次省略 `max_concurrency` 的 AmendWorkflow 沿用的就是这个数，所以它必须在模型面上
  // 可见——否则模型无从知道一次修订会继承什么。
  it("gives the run's concurrency bound its own tag, and only when there is one", () => {
    const limited = String(
      getWorkflowRunToolEntry.formatModelContent?.({ ...RUNNING_OUTPUT, maxConcurrency: 3 }),
    );
    expect(limited).toContain("<max_concurrency>3</max_concurrency>");
    expect(String(getWorkflowRunToolEntry.formatModelContent?.(RUNNING_OUTPUT))).not.toContain(
      "max_concurrency",
    );
  });

  // 同理：一次省略 `subagent_model` 的 AmendWorkflow 沿用的就是这个字符串。
  it("gives the run's subagent model its own tag, and only when there is one", () => {
    const chosen = String(
      getWorkflowRunToolEntry.formatModelContent?.({
        ...RUNNING_OUTPUT,
        subagentModel: "bigmodel/GLM-4.6$high",
      }),
    );
    expect(chosen).toContain("<subagent_model>bigmodel/GLM-4.6$high</subagent_model>");
    expect(String(getWorkflowRunToolEntry.formatModelContent?.(RUNNING_OUTPUT))).not.toContain(
      "subagent_model",
    );
  });

  // 脚本点名的模型（docs/dynamic-workflow/launch.md「GetWorkflowRun」）：修订里同名的模型沿用这些绑定。
  it("lists the script's model bindings one per line, next to the subagent model, only when there are any", () => {
    const bound = String(
      getWorkflowRunToolEntry.formatModelContent?.({
        ...RUNNING_OUTPUT,
        subagentModel: "bigmodel/GLM-4.6$high",
        modelBindings: {
          "GLM-5.3-Flash": "zhipu/GLM-5.3-Flash",
          "GLM-5.3$high": "zhipu/GLM-5.3$high",
        },
      }),
    );
    expect(bound).toContain(
      '<script_models>\n"GLM-5.3-Flash" = zhipu/GLM-5.3-Flash\n"GLM-5.3$high" = zhipu/GLM-5.3$high\n</script_models>',
    );
    expect(bound.indexOf("<subagent_model>")).toBeLessThan(bound.indexOf("<script_models>"));
    expect(String(getWorkflowRunToolEntry.formatModelContent?.(RUNNING_OUTPUT))).not.toContain(
      "script_models",
    );
  });

  // 脚本文件那一句进 `<amendable>`（docs/dynamic-workflow/launch.md「Script files」）：这一块
  // 说的就是「怎么修订」，少了文件就等于让模型去内联重贴一份两万 token 的脚本。
  it("names the script file inside <amendable>, in both the short and the full form", () => {
    const sentence =
      ' Its script is at .zcode/workflow-drafts/audit.dwf.ts: edit that file in place and pass `path: ".zcode/workflow-drafts/audit.dwf.ts"` to AmendWorkflow instead of a script.';

    // 健康在跑：整块只有一句话，脚本文件那一句仍然跟在后面。
    const running = String(
      getWorkflowRunToolEntry.formatModelContent?.({
        ...RUNNING_OUTPUT,
        scriptPath: ".zcode/workflow-drafts/audit.dwf.ts",
      }),
    );
    expect(running).toContain(`cache.${sentence}</amendable>`);

    // 终态（errored 是这一块最高价值的那一支）：完整论证之后接同一句。
    const errored = String(
      getWorkflowRunToolEntry.formatModelContent?.({
        ...RUNNING_OUTPUT,
        status: "errored" as const,
        scriptPath: ".zcode/workflow-drafts/audit.dwf.ts",
      }),
    );
    expect(errored).toContain("Do NOT rewrite from scratch.");
    expect(errored).toContain(`${sentence}</amendable>`);
  });

  it("says nothing about a script file when the run recorded none", () => {
    for (const output of [RUNNING_OUTPUT, { ...RUNNING_OUTPUT, status: "errored" as const }]) {
      const content = String(getWorkflowRunToolEntry.formatModelContent?.(output));
      expect(content).toContain("<amendable>");
      expect(content).not.toContain("Its script is at");
    }
  });

  it("says so in words when a running run has produced no log yet", () => {
    const content = String(
      getWorkflowRunToolEntry.formatModelContent?.({
        ...RUNNING_OUTPUT,
        actors: [],
        logTail: [],
      }),
    );

    expect(content).toMatch(/no log/i);
  });

  it("puts the artifact in its own block and the failure code in an attribute", () => {
    const completed = String(
      getWorkflowRunToolEntry.formatModelContent?.({
        ...RUNNING_OUTPUT,
        status: "completed",
        result: '{\n  "verdict": "ship"\n}',
      }),
    );
    const interrupted = String(
      getWorkflowRunToolEntry.formatModelContent?.({
        ...RUNNING_OUTPUT,
        status: "stopped",
        stopReason: "interrupted",
        error: { code: "Interrupted", message: "the owning process exited" },
      }),
    );

    expect(completed).toContain('<result>\n{\n  "verdict": "ship"\n}\n</result>');
    expect(interrupted).toContain("<stop_reason>interrupted</stop_reason>");
    expect(interrupted).toContain('<error code="Interrupted">the owning process exited</error>');
  });

  // provider 停下的 `<error>` 块与终态通知共用同一函数：原因 → 动作 → 事实行 → 原文行。
  it("renders a provider stop as the curated cause/fix block", () => {
    const content = String(
      getWorkflowRunToolEntry.formatModelContent?.({
        ...RUNNING_OUTPUT,
        status: "stopped",
        stopReason: "provider",
        error: {
          code: "ProviderStop",
          message: "Subagent turn failed: [1006] token expired",
          providerStop: {
            kind: "auth",
            reason: "auth_failed",
            providerId: "account:bigmodel-coding-plan",
            providerLabel: "BigModel",
            modelId: "GLM-5.3",
            providerCode: "1006",
            subagent: "verify@2",
            phase: "Verify",
            rawMessage: "[1006] token expired",
          },
        },
      }),
    );

    expect(content).toContain("<stop_reason>provider</stop_reason>");
    expect(content).toContain('<error code="ProviderStop">');
    expect(content).toContain("Sign-in to BigModel (account:bigmodel-coding-plan) expired");
    expect(content).toContain(`ResumeWorkflowRun with run_id="${RUNNING_OUTPUT.runId}"`);
    expect(content).toContain(
      "provider=account:bigmodel-coding-plan model=GLM-5.3 subagent=verify@2 phase=Verify code=1006",
    );
    expect(content).toContain("raw: [1006] token expired");
    // 可恢复提示要先让模型去解决原因，而不是盲目续跑。
    expect(content).toContain("<resumable>");
    expect(content).toMatch(/resolve the cause/i);
  });

  it("reports an invalid result instead of throwing", () => {
    expect(String(getWorkflowRunToolEntry.formatModelContent?.({ runId: 42 }))).toContain(
      "invalid result",
    );
  });

  // <resumable> 提示块的判定谓词与 port.resume 的门同语义：`stopped`，不论 reason
  // （apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md）。钉正反例，防它被放宽到 errored（ScriptError 的
  // run replay 会逐字复现失败，绝不能引导模型去恢复它）。
  it("adds the <resumable> hint exactly for stopped runs, with the reason-specific caveat", () => {
    const user = String(
      getWorkflowRunToolEntry.formatModelContent?.({
        ...RUNNING_OUTPUT,
        status: "stopped",
        stopReason: "user",
      }),
    );
    const interrupted = String(
      getWorkflowRunToolEntry.formatModelContent?.({
        ...RUNNING_OUTPUT,
        status: "stopped",
        stopReason: "interrupted",
        error: { code: "Interrupted", message: "the owning process exited" },
      }),
    );

    expect(user).toContain("<resumable>");
    expect(user).toContain("ResumeWorkflowRun");
    expect(interrupted).toContain("<resumable>");
    expect(interrupted).toContain("ResumeWorkflowRun");
    // user 的提示块要说明它是有人故意停的、只在用户要求时恢复；interrupted 不带这句
    // （cancel-resume 追记 2026-09-09）。
    expect(user).toMatch(/stopped on purpose/i);
    expect(user).toMatch(/only when the user asks/i);
    expect(interrupted).not.toMatch(/stopped on purpose/i);
    // 「原样续跑等用户开口」与「为修而停的现在就修」是两件事：model 停的提示块两句都要有，
    // user 停的只有前一句（amend-resume 追记 2026-09-14）。
    const model = String(
      getWorkflowRunToolEntry.formatModelContent?.({
        ...RUNNING_OUTPUT,
        status: "stopped",
        stopReason: "model",
      }),
    );
    expect(model).toMatch(/only if that is what the user wants/i);
    expect(model).toMatch(/amend it now/i);
    expect(user).not.toMatch(/amend it now/i);
    expect(getWorkflowRunToolEntry.metadata.description ?? "").toMatch(/only when the user asks/i);
  });

  it("keeps the <resumable> hint off every non-resumable state", () => {
    const nonResumable = [
      // completed：已经跑完，没有可恢复的东西。
      { ...RUNNING_OUTPUT, status: "completed" as const, result: "done" },
      // running / pending：在飞或未起飞，恢复是无意义动作。
      RUNNING_OUTPUT,
      { ...RUNNING_OUTPUT, status: "pending" as const },
      // errored：脚本真失败，replay 会逐字复现失败——谓词绝不能放宽到它。
      {
        ...RUNNING_OUTPUT,
        status: "errored" as const,
        error: { code: "DriverError", message: "the script itself failed" },
      },
    ];
    for (const detail of nonResumable) {
      expect(String(getWorkflowRunToolEntry.formatModelContent?.(detail))).not.toContain(
        "<resumable>",
      );
    }
  });

  // 修订续跑（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Terminal states」）：amend 的可用集是**任意
  // 终态**，与 plain resume 集刻意不同。两块提示各说各的，谁也不许污染谁。
  it("adds the <amendable> hint for every terminal run, including completed and ScriptError", () => {
    const terminal = [
      { ...RUNNING_OUTPUT, status: "completed" as const, result: "done" },
      { ...RUNNING_OUTPUT, status: "stopped" as const, stopReason: "user" as const },
      {
        ...RUNNING_OUTPUT,
        status: "errored" as const,
        error: { code: "DriverError", message: "the script itself failed" },
      },
      {
        ...RUNNING_OUTPUT,
        status: "stopped" as const,
        stopReason: "interrupted" as const,
        error: { code: "Interrupted", message: "the owning process exited" },
      },
    ];
    for (const detail of terminal) {
      const content = String(getWorkflowRunToolEntry.formatModelContent?.(detail));
      expect(content).toContain("<amendable>");
      expect(content).toContain("AmendWorkflow");
      expect(content).toContain("run_id");
      // run ID 进提示：模型可以直接照抄，不必回头翻 <run_id>。
      expect(content).toContain(RUNNING_OUTPUT.runId);
      // 只改设定时省略 script（docs/dynamic-workflow/launch.md「Keeping the predecessor's script」）：
      // 不说出来，模型会为了改一个数把整份脚本再抄一遍。
      expect(content).toContain(
        "To change only its settings (max_concurrency, subagent_model, name), omit both `script` and `path`: the new run keeps this run's script.",
      );
    }
  });

  // docs/dynamic-workflow/launch.md「The `AmendWorkflow` tool」：在飞的 run 也可修订（amend 会先停下它），
  // 所以提示块对 running / pending 也在场，尾句说的是「现在就改、不要先 TaskStop」。
  // 但**健康地在跑**的那一种收缩成一句：那时没有任何决定要模型现在做，整段论证只是在挤占
  // 它读花名册的注意力；还没起飞的（pending）和已经停滞的仍给完整论证。
  it("keeps the <amendable> hint on runs that have not finished, with the amend-now tail", () => {
    const stalled = {
      ...RUNNING_OUTPUT,
      health: { ...RUNNING_OUTPUT.health, stalledSince: Date.UTC(2026, 7, 21, 9, 3, 0) },
    };
    for (const detail of [{ ...RUNNING_OUTPUT, status: "pending" as const }, stalled]) {
      const content = String(getWorkflowRunToolEntry.formatModelContent?.(detail));
      expect(content).toContain("<amendable>");
      expect(content).toContain("It is still running");
      expect(content).toContain("Do not TaskStop it first");
    }
  });

  it("collapses <amendable> to one sentence while the run is running and healthy", () => {
    const content = String(getWorkflowRunToolEntry.formatModelContent?.(RUNNING_OUTPUT));

    expect(content).toContain(
      '<amendable>AmendWorkflow with run_id "dwfrun-running" supersedes this run with a revised script and imports its finished work as cache.</amendable>',
    );
    // 一句话形态不带「省略 script」那句：健康地在跑的 run 没有要模型现在做的决定。
    expect(content).not.toContain("omit both `script` and `path`");
    expect(content).not.toContain("Do not TaskStop it first");
  });

  it("replaces <resumable> and <amendable> with <superseded> on a superseded run", () => {
    const content = String(
      getWorkflowRunToolEntry.formatModelContent?.({
        ...RUNNING_OUTPUT,
        status: "stopped" as const,
        stopReason: "superseded" as const,
        supersededBy: "dwfrun-next",
      }),
    );
    expect(content).toContain("<superseded_by>dwfrun-next</superseded_by>");
    expect(content).toContain("<superseded>");
    expect(content).toContain("run dwfrun-next");
    expect(content).not.toContain("<resumable>");
    expect(content).not.toContain("<amendable>");
  });

  // 脚本真失败是修订的最高价值场景，而模型的默认反射是从头重写。尾句必须把它说破。
  it("tells a script-failed run to fix the script instead of rewriting from scratch", () => {
    const scriptError = String(
      getWorkflowRunToolEntry.formatModelContent?.({
        ...RUNNING_OUTPUT,
        status: "errored" as const,
        error: { code: "DriverError", message: "the script itself failed" },
      }),
    );

    expect(scriptError).toMatch(/rewrite/i);
    expect(scriptError).toMatch(/fix the script/i);
  });

  // 两块提示同时在场（stopped 既可 plain resume 又可修订）时，差别必须写在提示里：
  // 同 run 同脚本 vs 新 run 新脚本。否则模型只会看到两条都能点的路由。
  it("distinguishes plain resume from amend when a run qualifies for both", () => {
    const cancelled = String(
      getWorkflowRunToolEntry.formatModelContent?.({
        ...RUNNING_OUTPUT,
        status: "stopped" as const,
        stopReason: "user" as const,
      }),
    );

    expect(cancelled).toContain("<resumable>");
    expect(cancelled).toContain("<amendable>");
    // plain resume 侧的语义未被削弱：同 run ID、逐字节相同脚本。
    expect(cancelled).toContain("same run ID");
    expect(cancelled).toMatch(/byte-for-byte/i);
    // amend 侧：新 run、修订脚本。
    expect(cancelled).toMatch(/revised script/i);
  });
});

// ————————————————————————————————————————————————
// 停驻中的升级问题（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md）。
//
// 这是模型侧**唯一**的发现面：升级通知有两条已知的丢弃路径（stale branch generation /
// shutdown），而 `ResolveWorkflowQuestion` 只认 qid。spec 把「查询兜底」写成了那两条路径的
// 安全网，`unknown_question` 的服务端文案与升级通知也都明确指向这里——所以这几条断言钉住的
// 不是一个展示细节，而是那两处承诺是否兑现。
// ————————————————————————————————————————————————
const PARKED_QUESTIONS = [
  {
    qid: "dwfq-parked01-1",
    actor: "agent#1@1",
    actorName: "judge",
    question: "评分上限是 95，通过线是 96，这个门不可能过。",
    context: "已经试了 6 轮，最高 95。",
    askedAt: Date.UTC(2026, 7, 21, 9, 5, 0),
  },
  {
    qid: "dwfq-parked01-2",
    actor: "agent#2@1",
    question: "两条指令互相矛盾，先满足哪一条？",
    askedAt: Date.UTC(2026, 7, 21, 9, 4, 30),
  },
];

const PARKED_DETAIL: DynamicWorkflowRunDetail = {
  ...RUNNING_DETAIL,
  runId: "dwfrun-parked",
  pendingQuestions: PARKED_QUESTIONS,
};

const PARKED_OUTPUT: GetWorkflowRunOutput = {
  ...RUNNING_OUTPUT,
  runId: "dwfrun-parked",
  pendingQuestions: PARKED_QUESTIONS,
};

describe("GetWorkflowRun handler — pending escalations", () => {
  it("surfaces parked questions with their IDs, and keeps the field absent when there are none", async () => {
    const output = await call("dwfrun-parked", stubDetailPort({ "dwfrun-parked": PARKED_DETAIL }));
    const parsed = GetWorkflowRunOutputSchema.parse(output);

    expect(parsed.pendingQuestions).toHaveLength(2);
    expect(parsed.pendingQuestions?.[0]).toEqual({
      qid: "dwfq-parked01-1",
      actor: "agent#1@1",
      actorName: "judge",
      question: "评分上限是 95，通过线是 96，这个门不可能过。",
      context: "已经试了 6 轮，最高 95。",
      askedAt: Date.UTC(2026, 7, 21, 9, 5, 0),
    });
    // 匿名 actor 不合成兜底名；可选字段缺席就是缺席。
    expect(parsed.pendingQuestions?.[1] && "actorName" in parsed.pendingQuestions[1]).toBe(false);
    expect(parsed.pendingQuestions?.[1] && "context" in parsed.pendingQuestions[1]).toBe(false);

    // 零条 → 整字段缺席（空数组读起来像「问过、已答完」，缺席才是「没人在等」）。
    const idle = await call("dwfrun-running", stubDetailPort({ "dwfrun-running": RUNNING_DETAIL }));
    expect("pendingQuestions" in idle).toBe(false);
    const empty = await call(
      "dwfrun-empty",
      stubDetailPort({ "dwfrun-empty": { ...RUNNING_DETAIL, runId: "dwfrun-empty", pendingQuestions: [] } }),
    );
    expect("pendingQuestions" in empty).toBe(false);
  });

  it("renders the pending block with the qid and the ResolveWorkflowQuestion instruction", () => {
    const content = String(getWorkflowRunToolEntry.formatModelContent?.(PARKED_OUTPUT));

    expect(content).toContain("<pending_questions>");
    expect(content).toContain("dwfq-parked01-1");
    expect(content).toContain("dwfq-parked01-2");
    expect(content).toContain("judge");
    // 匿名 actor 落到结构化 ref。
    expect(content).toContain("agent#2@1");
    expect(content).toContain("ResolveWorkflowQuestion");
    // 排在 log 尾巴之前：一个停驻的 actor 是此刻要做的事，不该埋在二十行叙事后面。
    expect(content.indexOf("<pending_questions>")).toBeLessThan(content.indexOf("<log_tail>"));
  });

  it("omits the pending block entirely for a run with nothing parked", () => {
    expect(String(getWorkflowRunToolEntry.formatModelContent?.(RUNNING_OUTPUT))).not.toContain(
      "pending_questions",
    );
  });
});

// ————————————————————————————————————————————————
// 情势截面（docs/dynamic-workflow/launch.md「`GetWorkflowRun`」）。
//
// 三个场景钉的是同一件事：这份输出能不能回答「run 在哪、谁在干什么、它还在动吗」。
// 块序是契约，每一行的事实也是——所以这里既断言顺序，也断言那几行的字。
// `summary` 用真正的拼装器铸出（不是手写一句），于是这三段文本就是端到端的真实渲染。
// ————————————————————————————————————————————————

/** 块在文本里的出现位置，用来断言块序。 */
function blockOrder(content: string, tags: readonly string[]): number[] {
  return tags.map((tag) => content.indexOf(tag));
}

function renderWithSummary(base: Omit<GetWorkflowRunOutput, "summary">): string {
  const output: GetWorkflowRunOutput = { ...base, summary: buildWorkflowRunSummary(base) };
  return String(getWorkflowRunToolEntry.formatModelContent?.(output));
}

const SITREP_BASE: Omit<GetWorkflowRunOutput, "summary"> = {
  runId: "dwfrun-7f3a",
  label: "nightly triage",
  labelSource: "name",
  status: "running",
  ownedByThisSession: true,
  createdAt: Date.UTC(2026, 7, 21, 9, 0, 0),
  updatedAt: Date.UTC(2026, 7, 21, 9, 5, 0),
  generatedAt: NOW,
  maxConcurrency: 3,
  subagentModel: "bigmodel/GLM-4.6$high",
  // 计数与花名册互相对齐：活相位的子代理各占一条还在跑的 ask 行（executing / waiting /
  // parked 各一），所以 nodesRunning = 3；nodesObserved 是三态之和 = 5 + 3。
  usage: {
    spentTokens: 18_420,
    nodesObserved: 8,
    nodesRunning: 3,
    nodesCompleted: 5,
    nodesFailed: 0,
  },
  actors: [
    { siteId: "agent#1", ordinal: 1, name: "collector" },
    { siteId: "agent#2", ordinal: 1, name: "judge" },
    { siteId: "agent#2", ordinal: 2, name: "judge" },
    { siteId: "agent#3", ordinal: 1 },
  ],
  logTail: [
    { sequence: 11, message: "collected 14 failing specs", at: Date.UTC(2026, 7, 21, 9, 0, 50) },
    { sequence: 14, message: "dispatching judges in pairs", at: Date.UTC(2026, 7, 21, 9, 1, 50) },
    { sequence: 19, message: "judge#1 finished: 6 flaky, 1 real", at: Date.UTC(2026, 7, 21, 9, 4, 10) },
  ],
  phases: [
    { name: "collect", state: "done", rounds: 1, nodesSettled: 2, nodesRunning: 0, enteredAt: Date.UTC(2026, 7, 21, 9, 0, 0), exitedAt: Date.UTC(2026, 7, 21, 9, 1, 20) },
    { name: "judge", state: "current", rounds: 1, nodesSettled: 3, nodesRunning: 3, enteredAt: Date.UTC(2026, 7, 21, 9, 1, 20) },
    { name: "verify", state: "ahead", rounds: 0, nodesSettled: 0, nodesRunning: 0 },
    { name: "report", state: "ahead", rounds: 0, nodesSettled: 0, nodesRunning: 0 },
  ],
  subagents: [
    {
      siteId: "agent#1",
      ordinal: 1,
      name: "collector",
      // 活着的 run 上端口从不发 `done`（那是终态词）：干完自己那份活的子代理是 `idle`。
      state: "idle",
      phaseName: "collect",
      stepsSettled: 2,
      stepsFailed: 0,
      tokens: 6_210,
    },
    {
      siteId: "agent#2",
      ordinal: 1,
      name: "judge",
      state: "parked",
      phaseName: "judge",
      currentAsk: {
        siteId: "ask#4",
        ordinal: 0,
        actorSeq: 1,
        instructionsHead: "Judge specs 8-14 for flakiness; report real failures with evidence",
        startedAt: Date.UTC(2026, 7, 21, 9, 2, 0),
      },
      parkedOn: "q-01",
      stepsSettled: 1,
      stepsFailed: 0,
      tokens: 4_980,
    },
    {
      siteId: "agent#2",
      ordinal: 2,
      name: "judge",
      state: "executing",
      phaseName: "judge",
      currentAsk: {
        siteId: "ask#4",
        ordinal: 1,
        actorSeq: 2,
        instructionsHead: "Judge specs 1-7 for flakiness; report real failures with evidence",
        startedAt: Date.UTC(2026, 7, 21, 9, 4, 28),
        turn: 4,
        toolCalls: 7,
        lastTool: { name: "Read", target: "packages/net/retry.spec.ts", at: Date.UTC(2026, 7, 21, 9, 5, 32) },
      },
      stepsSettled: 1,
      stepsFailed: 0,
      tokens: 5_100,
      lastProgressAt: Date.UTC(2026, 7, 21, 9, 5, 32),
    },
    {
      siteId: "agent#3",
      ordinal: 1,
      state: "waiting",
      phaseName: "judge",
      wait: { cause: "backoff", reason: "429", retryAfterMs: 20_000, since: Date.UTC(2026, 7, 21, 9, 5, 20) },
      stepsSettled: 1,
      stepsFailed: 0,
      tokens: 2_130,
    },
  ],
  health: {
    lastProgressAt: Date.UTC(2026, 7, 21, 9, 5, 0),
    concurrency: { effective: 2, cap: 3, reason: "rate_limited", since: Date.UTC(2026, 7, 21, 9, 4, 35) },
    consecutiveFailures: 0,
    cachedSteps: 0,
    pendingQuestionsKnown: true,
  },
  pendingQuestions: [
    {
      qid: "q-01",
      actor: "agent#2@1",
      actorName: "judge",
      question: "Two specs disagree on the retry budget; which one is authoritative?",
      context: "packages/net/retry.spec.ts vs docs/net/retry.md",
      askedAt: Date.UTC(2026, 7, 21, 9, 5, 0),
    },
  ],
  artifacts: [{ id: "triage-board", kind: "board", title: "Triage board", version: 3, itemCount: 7 }],
};

describe("GetWorkflowRun model content — a running situation report", () => {
  const content = renderWithSummary(SITREP_BASE);

  it("keeps the contract block order, summary first and routing last", () => {
    const order = blockOrder(content, [
      "<summary>",
      "<run_id>",
      "<status>",
      "<max_concurrency>",
      "<subagent_model>",
      "<created_at>",
      "<pending_questions>",
      "<health>",
      "<phases>",
      "<subagents>",
      "<log_tail>",
      "<usage>",
      "<artifacts",
      "<amendable>",
    ]);
    expect(order).toEqual([...order].sort((left, right) => left - right));
    expect(order.every((index) => index >= 0)).toBe(true);
  });

  it("assembles the summary from status, phase position, step counts, questions and progress", () => {
    expect(content).toContain(
      "<summary>Running for 5m 40s, in phase 2 of 4 (judge). 5 of 8 dispatched steps settled, 3 running (1 executing, 1 waiting, 1 parked). 1 question awaiting your answer. Last progress 40s ago.</summary>",
    );
  });

  it("reports health on one line with the throttle and its age", () => {
    expect(content).toContain(
      "<health>last_progress=40s ago  concurrency=2/3 (rate_limited since 1m 05s ago)  stalled=no  consecutive_failures=0  cached_steps=0</health>",
    );
  });

  // `ahead` 的行只有名字和状态：它还没发生过，所以没有轮次、没有计数、没有时长。
  it("draws the phase table with rounds, counts and the current phase's time so far", () => {
    expect(content).toContain("1. collect  done     1 round  2 steps settled  1m 20s");
    expect(content).toContain("2. judge    current  1 round  3 settled, 3 running  4m 20s so far");
    expect(content).toContain("3. verify   ahead");
    expect(content).toContain("4. report   ahead");
  });

  // 一行读作「谁 · 在哪 · 什么相位 · 哪个阶段 · 在做什么 · 花了多少」。
  it("draws one roster line per subagent, with the ask, the last tool and the wait cause", () => {
    expect(content).toContain(
      "judge      agent#2@2  executing  phase judge  ask#4@1 (step 3), 1m 12s on this step, turn 4, 7 tool calls, last Read packages/net/retry.spec.ts 8s ago  5,100 tokens",
    );
    expect(content).toContain("judge      agent#2@1  parked     phase judge  on question q-01 for 40s  4,980 tokens");
    expect(content).toContain("agent#3@1  waiting    phase judge  backoff after 429 for 20s, retry in 20s  2,130 tokens");
    expect(content).toContain("collector  agent#1@1  idle       phase collect  2 steps  6,210 tokens");
    // 任务摘要缩进一行挂在它所属的那一行下面。
    expect(content).toContain("  task: Judge specs 1-7 for flakiness; report real failures with evidence");
  });

  it("prefixes each log line with its age", () => {
    expect(content).toContain("[19]  1m 30s ago  judge#1 finished: 6 flaky, 1 real");
  });

  it("dates the parked question by age instead of an ISO instant", () => {
    expect(content).toContain("[q-01] judge asked 40s ago");
    expect(content).toContain("ResolveWorkflowQuestion");
  });
});

describe("GetWorkflowRun model content — a completed run", () => {
  const completed: Omit<GetWorkflowRunOutput, "summary"> = {
    ...SITREP_BASE,
    status: "completed",
    updatedAt: Date.UTC(2026, 7, 21, 9, 4, 20),
    usage: { ...SITREP_BASE.usage, spentTokens: 41_200, nodesRunning: 0, nodesCompleted: 12, nodesObserved: 12 },
    phases: [
      { name: "collect", state: "done", rounds: 1, nodesSettled: 2, nodesRunning: 0, enteredAt: Date.UTC(2026, 7, 21, 9, 0, 0), exitedAt: Date.UTC(2026, 7, 21, 9, 1, 20) },
      { name: "judge", state: "done", rounds: 1, nodesSettled: 6, nodesRunning: 0, enteredAt: Date.UTC(2026, 7, 21, 9, 1, 20), exitedAt: Date.UTC(2026, 7, 21, 9, 3, 0) },
      { name: "verify", state: "done", rounds: 2, nodesSettled: 3, nodesRunning: 0, enteredAt: Date.UTC(2026, 7, 21, 9, 3, 0), exitedAt: Date.UTC(2026, 7, 21, 9, 4, 0) },
      { name: "report", state: "done", rounds: 1, nodesSettled: 1, nodesRunning: 0, enteredAt: Date.UTC(2026, 7, 21, 9, 4, 0), exitedAt: Date.UTC(2026, 7, 21, 9, 4, 20) },
    ],
    // 终态 run 上干完的子代理才是 `done`。
    subagents: [{ ...SITREP_BASE.subagents[0]!, state: "done" }],
    health: { lastProgressAt: Date.UTC(2026, 7, 21, 9, 4, 20), consecutiveFailures: 0, cachedSteps: 2, pendingQuestionsKnown: true },
    pendingQuestions: undefined,
    result: "12 specs triaged",
    artifacts: [
      { id: "report", kind: "markdown", title: "Nightly triage report", version: 1, itemCount: 0, primary: true },
    ],
  };
  const content = renderWithSummary(completed);

  it("counts phases instead of pointing at one, and names the deliverable", () => {
    expect(content).toContain(
      "<summary>Completed in 4m 20s, across 4 phases. 12 steps settled, 41,200 tokens. Deliverable: Nightly triage report (markdown, primary).</summary>",
    );
  });

  // 终态 run 不报 stalled（它当然不动了），也不报 leftover（没有残留行）。
  it("drops the stalled reading from a terminal run's health", () => {
    expect(content).toContain("<health>last_progress=1m 20s ago  consecutive_failures=0  cached_steps=2</health>");
    expect(content).not.toContain("stalled=");
    expect(content).not.toContain("leftover");
  });

  it("gives every phase its duration and no 'so far'", () => {
    expect(content).toContain("2. judge    done  1 round  6 steps settled  1m 40s");
    expect(content).toContain("3. verify   done  2 rounds  3 steps settled  1m 00s");
    expect(content).not.toContain("so far");
  });
});

describe("GetWorkflowRun model content — an interrupted run seen from another session", () => {
  const interrupted: Omit<GetWorkflowRunOutput, "summary"> = {
    ...SITREP_BASE,
    status: "stopped",
    stopReason: "interrupted",
    ownedByThisSession: false,
    updatedAt: Date.UTC(2026, 7, 21, 9, 5, 0),
    error: { code: "Interrupted", message: "the owning process exited" },
    // 终态 run 里「还在跑」的行就是残留行：nodesRunning = leftoverRunning = 两个 unfinished
    // 子代理各自那一条。observed 仍是三态之和 = 5 + 2。
    usage: { ...SITREP_BASE.usage, nodesObserved: 7, nodesRunning: 2 },
    phases: [
      { name: "collect", state: "done", rounds: 1, nodesSettled: 2, nodesRunning: 0, enteredAt: Date.UTC(2026, 7, 21, 9, 0, 0), exitedAt: Date.UTC(2026, 7, 21, 9, 1, 20) },
      { name: "judge", state: "unfinished", rounds: 1, nodesSettled: 3, nodesRunning: 2, enteredAt: Date.UTC(2026, 7, 21, 9, 1, 20) },
      { name: "verify", state: "ahead", rounds: 0, nodesSettled: 0, nodesRunning: 0 },
      { name: "report", state: "ahead", rounds: 0, nodesSettled: 0, nodesRunning: 0 },
    ],
    subagents: [
      { ...SITREP_BASE.subagents[0]!, state: "done" },
      {
        siteId: "agent#2",
        ordinal: 1,
        name: "judge",
        state: "unfinished",
        phaseName: "judge",
        currentAsk: { siteId: "ask#4", ordinal: 0, actorSeq: 1, startedAt: Date.UTC(2026, 7, 21, 9, 2, 0) },
        stepsSettled: 1,
        stepsFailed: 0,
        tokens: 4_980,
      },
      {
        siteId: "agent#2",
        ordinal: 2,
        name: "judge",
        state: "unfinished",
        phaseName: "judge",
        currentAsk: { siteId: "ask#4", ordinal: 1, actorSeq: 2, startedAt: Date.UTC(2026, 7, 21, 9, 4, 28) },
        stepsSettled: 1,
        stepsFailed: 0,
        tokens: 5_100,
      },
    ],
    health: {
      lastProgressAt: Date.UTC(2026, 7, 21, 9, 5, 0),
      consecutiveFailures: 0,
      cachedSteps: 0,
      leftoverRunning: 2,
      // 停驻表只活在提问那个进程的内存里：这次读根本不知道有没有人在等。
      pendingQuestionsKnown: false,
    },
    pendingQuestions: undefined,
    artifacts: undefined,
  };
  const content = renderWithSummary(interrupted);

  it("says the leftovers will be re-dispatched and that the run is another session's", () => {
    expect(content).toContain(
      "<summary>Stopped (interrupted) 40s ago after 5m 00s, in phase 2 of 4 (judge). 5 of 7 dispatched steps settled; 2 were still running when the owning process exited and will be re-dispatched on resume. Pending questions are unknown from this session. Owned by another session.</summary>",
    );
  });

  // 沉默会被读成「没有人在等」，而那是最危险的误读——这是仅有的两处「把不知道说出口」之一。
  it("replaces the pending block with the explicit unknown sentence", () => {
    expect(content).toContain("<pending_questions>Unknown: pending questions are tracked only by the process");
    expect(content).toContain("Resuming the run will re-ask any question its subagent still needs answered.");
    expect(content).not.toContain("[q-01]");
  });

  // 另一处：终态 run 里标着 running 的行是残留，不是活的工作。
  it("adds the leftover note under health and marks the phase unfinished", () => {
    expect(content).toContain('The 2 "running" steps below are leftovers of the exited process, not live work.');
    expect(content).toContain("2. judge    unfinished  1 round  3 settled, 2 unfinished");
    expect(content).toContain("judge      agent#2@1  unfinished  phase judge  ask#4@0 (step 2) was in flight at the stop");
  });

  it("still routes to ResumeWorkflowRun and AmendWorkflow with the full argument", () => {
    expect(content).toContain("<resumable>");
    expect(content).toContain("<amendable>");
    expect(content).toContain("Use it when the script or a setting needs to change");
  });
});

describe("GetWorkflowRun declaration", () => {
  it("declares a read-only, no-side-effect capability consistently on both faces", () => {
    expect(getWorkflowRunToolEntry.metadata).toMatchObject({
      name: GET_WORKFLOW_RUN_TOOL_NAME,
      readOnly: true,
      destructive: false,
      concurrentSafe: true,
      needsApproval: false,
      sideEffectScope: "none",
      riskLevel: "low",
      timeoutMs: 10_000,
    });
    expect(getWorkflowRunToolEntry.permission).toMatchObject({
      permission: "getWorkflowRun",
      needsApproval: false,
      sideEffectScope: "none",
      riskLevel: "low",
      denyPriority: "beforeAsk",
    });
    expect(getWorkflowRunToolEntry.permission.alwaysAsk).toBeUndefined();
  });

  // 产物就是可能大到需要 artifact 的那类载荷（照 TaskOutput）。
  it("budgets the result as a persistable artifact", () => {
    expect(getWorkflowRunToolEntry.resultBudget).toMatchObject({
      maxInlineBytes: 400_000,
      maxModelBytes: 400_000,
      strategy: "artifact",
      artifact: { enabled: true, retention: "session" },
    });
    expect(getWorkflowRunToolEntry.maxModelChars).toBe(100_000);
    expect(getWorkflowRunToolEntry.resultArtifactContentType).toBe("text/plain");
  });

  // tool-contracts.test.ts 的 v2 全量循环在第一处不一致就中止；新工具在这里各自再钉一遍。
  it("declares the v2 common contract", () => {
    expectV2CommonContract(getWorkflowRunToolEntry);
  });

  it("steers the model to TaskOutput for blocking waits and away from polling", () => {
    const description = getWorkflowRunToolEntry.metadata.description ?? "";

    expect(description).toMatch(/do not poll/i);
    expect(description).toMatch(/notification/i);
    expect(description).toContain("TaskOutput");
    expect(description).toMatch(/wait/i);
    expect(description).toContain("ListWorkflowRuns");
  });

  // 路由引导（2026-08-29）：可恢复终态要指路 ResumeWorkflowRun。钉关键词，不钉逐字。
  it("cross-references ResumeWorkflowRun for the resumable terminal states", () => {
    const description = getWorkflowRunToolEntry.metadata.description ?? "";

    expect(description).toContain("ResumeWorkflowRun");
    expect(description).toMatch(/cancel/i);
    expect(description).toContain("interrupted");
  });

  // 修订续跑（2026-08-31）：描述里也要有第二条路由，且必须与上一条区分开。
  it("cross-references AmendWorkflow for any run and names the superseded state", () => {
    const description = getWorkflowRunToolEntry.metadata.description ?? "";

    expect(description).toContain("AmendWorkflow");
    expect(description).not.toContain("resume_from");
    expect(description).toMatch(/revised/i);
    expect(description).toContain("superseded");
  });
});

describe("GetWorkflowRun registration", () => {
  it("is always on, with no gate option", () => {
    const registry = createToolRegistry();
    registerBuiltInTools(registry);

    expect(registry.has(GET_WORKFLOW_RUN_TOOL_NAME)).toBe(true);
    expect(registry.toContracts().map((tool) => tool.name)).toContain(GET_WORKFLOW_RUN_TOOL_NAME);
  });

  for (const mode of ["plan", "build", "yolo"] as const) {
    it(`is auto-allowed in ${mode} mode`, () => {
      const capability = resolveRuntimePermissionCapability(
        getWorkflowRunToolEntry,
        { run_id: "dwfrun-x" },
        {
          workingDirectory: "/workspace/project",
          workspaceRoot: "/workspace/project",
        } as never,
      );

      expect(
        new PermissionService().checkPermission(
          {
            input: { run_id: "dwfrun-x" },
            mode,
            riskLevel: "low",
            toolName: GET_WORKFLOW_RUN_TOOL_NAME,
          },
          capability,
        ),
      ).toMatchObject({ allowed: true, decision: "allow" });
    });
  }
});

// 留白（docs/dynamic-workflow/launch.md「The `FillWorkflowHole` tool」）：`holes` 与 pendingQuestions 同规——
// 零条缺席、逐字段镜像；模型面的 `<holes>` 块列出等着的与补过的，并点名 FillWorkflowHole 与 hole_id。
describe("GetWorkflowRun handler — holes", () => {
  const holes = [
    {
      siteId: "hole#1",
      ordinal: 1,
      name: "决定分组",
      type: "Verdict",
      state: "waiting" as const,
      since: NOW - 40_000,
    },
    {
      siteId: "hole#2",
      ordinal: 1,
      name: "收尾",
      type: "string",
      state: "filled" as const,
      filledAt: NOW - 10_000,
      filledBy: "sess_get_run",
    },
  ];

  it("mirrors the holes list and leaves it absent when empty", async () => {
    const detail: DynamicWorkflowRunDetail = { ...RUNNING_DETAIL, holes };
    const output = await call("dwfrun-running", stubDetailPort({ "dwfrun-running": detail }));
    expectMirrorsDetail(output, detail);
    // 摘要也点一句：等着的留白是此刻等着模型做的事（补过的不算）。
    expect(output.summary).toContain("1 hole awaiting your code.");
    const empty = await call(
      "dwfrun-running",
      stubDetailPort({ "dwfrun-running": { ...RUNNING_DETAIL, holes: [] } }),
    );
    expect("holes" in empty).toBe(false);
    expect(empty.summary).not.toContain("hole");
  });

  it("renders a <holes> block naming FillWorkflowHole and the hole ids, after pending questions", () => {
    const text = getWorkflowRunToolEntry.formatModelContent!({
      ...RUNNING_OUTPUT,
      pendingQuestions: [
        { qid: "dwfq-1", actor: "agent#1@1", question: "q?", askedAt: NOW - 5_000 },
      ],
      holes,
    }) as string;
    expect(text).toContain("<holes>");
    expect(text).toContain('[hole#1] "决定分组": Verdict — waiting 40s');
    expect(text).toContain('[hole#2] "收尾": string — filled 10s ago');
    expect(text).toContain(
      'FillWorkflowHole with run_id="dwfrun-running" and the hole id in brackets as hole_id',
    );
    expect(text.indexOf("<pending_questions>")).toBeLessThan(text.indexOf("<holes>"));
    expect(text.indexOf("<holes>")).toBeLessThan(text.indexOf("<health"));
    expect(getWorkflowRunToolEntry.formatModelContent!(RUNNING_OUTPUT) as string).not.toContain(
      "<holes>",
    );
  });
});

// 递归留白：嵌套站点 id 在 `<holes>` 块的方括号里逐字出现（转义不碰 `/` 与 `#`）。
describe("GetWorkflowRun — nested hole ids", () => {
  it("prints the nested site id verbatim", () => {
    const text = getWorkflowRunToolEntry.formatModelContent!({
      ...RUNNING_OUTPUT,
      holes: [
        {
          siteId: "hole#1/hole#1/hole#2",
          ordinal: 1,
          name: "内层",
          type: "Inner",
          state: "waiting" as const,
          since: NOW - 1_000,
        },
      ],
    }) as string;
    expect(text).toContain('[hole#1/hole#1/hole#2] "内层": Inner — waiting 1s');
  });
});
