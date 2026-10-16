/**
 * 端到端管线：真实脚本 → lowering → 沙箱子进程 → 引擎 → AutoDriver。断言最终 artifact、
 * journal 内容（节点 actorSeq / inputHash / result）、事件流合理性。见 docs/execution-engine.md。
 */

import { describe, expect, it } from "vitest";
import { InMemoryJournalStore, WorkflowError, inputHash } from "@zcode/dynamic-workflow";
import { runScript } from "./helpers.js";

const RUN = "run";

describe("e2e — single typed ask", () => {
  it("lowers, runs in the sandbox, validates the submit, and returns the artifact", async () => {
    const script = [
      "interface Summary { title: string; points: string[]; }",
      'const worker = agent("worker", "You summarize repos.");',
      'const s = await worker.ask<Summary>("Summarize the repo");',
      "log(`title: ${s.title}`);",
      "return s;",
    ].join("\n");

    const artifact = { title: "The Repo", points: ["a", "b"] };
    const { settlement, journal, driver } = await runScript(script, {
      asks: {
        "ask#1": () => ({
          type: "submit",
          payload: artifact,
          stats: { tokens: 42, toolCalls: 1, turns: 1 },
        }),
      },
    });

    expect(settlement).toEqual({ status: "completed", artifact });

    // journal：ask 节点已 completed，带 actorSeq / inputHash / stats / actor 归属。
    const node = journal.getNode(RUN, "ask#1", 1);
    expect(node?.status).toBe("completed");
    expect(node?.kind).toBe("ask");
    expect(node?.result).toEqual(artifact);
    expect(node?.actorSeq).toBe(0);
    expect(node?.inputHash).toBe(inputHash("Summarize the repo"));
    expect(node?.stats?.tokens).toBe(42);
    expect(node?.actorSiteId).toBe("actor#1");

    // actor 落库。
    const actor = journal.getActor(RUN, "actor#1", 1);
    expect(actor?.name).toBe("worker");
    expect(actor?.persona?.system).toBe("You summarize repos.");

    // 事件流合理性：run-started → actor-created → node dispatched → settled(ok) → run-settled(completed)。
    const types = driver.events.map((e) => e.type);
    expect(types[0]).toBe("run-started");
    expect(types).toContain("actor-created");
    expect(types).toContain("node-dispatched");
    expect(driver.eventsOfType("log").some((e) => e.message === "title: The Repo")).toBe(true);
    const settled = driver.eventsOfType("node-settled");
    expect(settled.at(-1)?.outcome).toBe("ok");
    expect(types.at(-1)).toBe("run-settled");
  });
});

describe("e2e — world reads + typed ask", () => {
  it("journals glob/read with input hashes and threads their results into an ask", async () => {
    const script = [
      "interface Verdict { approved: boolean; reason: string; }",
      'const paths = await files.glob("src/**/*.ts");',
      'const first = paths[0] ?? "none";',
      "const text = await files.read(first);",
      "log(`read ${text.length} bytes from ${first}`);",
      'const v = await agent("reviewer").ask<Verdict>(`Review ${first}`);',
      "return { count: paths.length, first, approved: v.approved };",
    ].join("\n");

    const files = { glob: ["src/a.ts", "src/b.ts"], read: "export const x = 1;\n" };
    const seenArgs: unknown[][] = [];
    const { settlement, journal } = await runScript(script, {
      worldReads: (op, args) => {
        // Boundary A 送到 driver 的是**位置实参数组**（lowering 原样打包，不看 op）。
        seenArgs.push(args);
        return op === "glob" ? files.glob : files.read;
      },
      asks: {
        "ask#1": ({ message }) => {
          // 指令里应插值了 glob 的首个结果，证明 world-read 结果确实回流进脚本。
          expect(message.instructions).toContain("src/a.ts");
          return { type: "submit", payload: { approved: true, reason: "ok" } };
        },
      },
    });

    expect(settlement).toEqual({
      status: "completed",
      artifact: { count: 2, first: "src/a.ts", approved: true },
    });

    const glob = journal.getNode(RUN, "world-read#1", 1);
    expect(glob?.kind).toBe("world-read");
    expect(glob?.result).toEqual(files.glob);
    // inputHash 覆盖 {op, args}：脚本实参跨沙箱边界后仍是位置数组。
    expect(glob?.inputHash).toBe(inputHash({ op: "glob", args: ["src/**/*.ts"] }));
    const read = journal.getNode(RUN, "world-read#2", 1);
    expect(read?.result).toBe(files.read);
    expect(read?.inputHash).toBe(inputHash({ op: "read", args: ["src/a.ts"] }));
    // 数组穿过 NDJSON 线协议后逐元素保真（protocol.ts 的 args 与 child-source 的镜像一致）。
    expect(seenArgs).toEqual([["src/**/*.ts"], ["src/a.ts"]]);
  });

  it("carries multi-arg and optional-arg ops through the wire unchanged", async () => {
    // 线协议的形状**没变**（op 串 + args 数组），所以新增的 grep / git.* 走的是同一条路。
    // 这条用例证明它：一份同时用到多参、可选缺省、无参、以及与顶层 `log()` 撞名的
    // `git.log` 的脚本，跨沙箱边界后 driver 收到的 (op, args) 逐个对得上。
    const script = [
      'const hits = await files.grep("TODO", "*.ts");',
      'const narrow = await files.grep("FIXME");',
      "const changed = await git.changedFiles();",
      'const diff = await git.diff("main", "src/a.ts");',
      "const status = await git.status();",
      "const commits = await git.log(3);",
      'log(`${hits.length} TODOs on ${status.branch ?? "detached"}`);',
      "return {",
      "  hits: hits.length + narrow.length,",
      "  changed: changed.length,",
      "  diffBytes: diff.length,",
      "  commits: commits.map((c) => c.hash),",
      "};",
    ].join("\n");

    const seen: { op: string; args: unknown[] }[] = [];
    const { settlement, journal } = await runScript(script, {
      worldReads: (op, args) => {
        seen.push({ op, args });
        switch (op) {
          case "grep":
            return [{ path: "src/a.ts", line: 7, text: "// TODO" }];
          case "git-changed-files":
            return ["src/a.ts", "src/b.ts"];
          case "git-diff":
            return "@@ -1 +1 @@\n";
          case "git-status":
            return {
              branch: "main",
              clean: false,
              staged: [],
              unstaged: ["src/a.ts"],
              untracked: [],
            };
          default:
            return [{ hash: "abc", subject: "s", author: "a", date: "2026-08-20T00:00:00+08:00" }];
        }
      },
    });

    expect(settlement).toEqual({
      status: "completed",
      artifact: { hits: 2, changed: 2, diffBytes: 12, commits: ["abc"] },
    });
    // 缺省的尾部可选实参到达时是**更短的数组**，不是一个 undefined 洞。
    expect(seen).toEqual([
      { op: "grep", args: ["TODO", "*.ts"] },
      { op: "grep", args: ["FIXME"] },
      { op: "git-changed-files", args: [] },
      { op: "git-diff", args: ["main", "src/a.ts"] },
      { op: "git-status", args: [] },
      { op: "git-log", args: [3] },
    ]);
    // 六个 world-read 站点共用一个 per-kind 计数器；`log(...)` 一个站点都不占。
    expect(journal.getNode(RUN, "world-read#6", 1)?.inputHash).toBe(
      inputHash({ op: "git-log", args: [3] }),
    );
    expect(journal.getNode(RUN, "world-read#7", 1)).toBeUndefined();
  });
});

describe("e2e — fan-out over Promise.all", () => {
  it("runs one ask instance per globbed path, each on its own actor", async () => {
    const script = [
      "interface Verdict { approved: boolean; reason: string; }",
      'const paths = await files.glob("src/**/*.ts");',
      "const verdicts = await Promise.all(",
      // 逐元素名：fan-out 里每个元素都是一个新 actor，共用一个静态名会撞运行期的
      // DuplicateActorName（编译期另有 9005 的 fan-out 子句，见 analysis/actor-names.ts）。
      "  paths.map((p) => agent(`reviewer-${p}`).ask<Verdict>(`Security-review ${p}`)),",
      ");",
      "return verdicts.filter((v) => !v.approved).map((v) => v.reason);",
    ].join("\n");

    const paths = ["src/a.ts", "src/b.ts", "src/c.ts"];
    const { settlement, journal, driver } = await runScript(script, {
      worldReads: () => paths,
      asks: {
        // 按指令里的路径决定裁决：b 不通过。
        "ask#1": ({ message }) => {
          const approved = !message.instructions.includes("src/b.ts");
          return {
            type: "submit",
            payload: { approved, reason: approved ? "clean" : "vuln in b" },
          };
        },
      },
    });

    expect(settlement).toEqual({ status: "completed", artifact: ["vuln in b"] });

    // 三个 ask 实例（ask#1@1..3），三个 actor（actor#1@1..3），全部 completed。
    const askNodes = journal
      .listNodes(RUN, { kinds: "all", withResult: true })
      .filter((n) => n.kind === "ask");
    expect(askNodes).toHaveLength(3);
    expect(askNodes.every((n) => n.status === "completed")).toBe(true);
    expect(driver.sessionCreations).toHaveLength(3);
    // ok 结算 = 3 个 ask + 1 个 glob world-read。
    expect(driver.eventsOfType("node-settled").filter((e) => e.outcome === "ok")).toHaveLength(4);
  });
});

describe("e2e — untyped ask (final text)", () => {
  it("settles an untyped ask on turn-end with the final text; no submit tool offered", async () => {
    const script = [
      'const a = agent("assistant");',
      'const answer = await a.ask("What is 2+2?");',
      "return answer;",
    ].join("\n");

    const { settlement, journal, driver } = await runScript(script, {
      asks: { "ask#1": () => ({ type: "text", finalText: "four" }) },
    });

    expect(settlement).toEqual({ status: "completed", artifact: "four" });
    expect(driver.startAsks[0]?.message.typed).toBe(false);
    expect(journal.getNode(RUN, "ask#1", 1)?.result).toBe("four");
  });
});

describe("e2e — report (progressive results)", () => {
  it("journals each reported item and emits it, without deadlocking the child", async () => {
    // report 走**事件通道**而不是 request/response：脚本从不 await 它，所以子进程发完就继续跑。
    // 这条用例同时是那件事的活性证明——若父进程误以为需要回一个 response，脚本会永远停在
    // 第一个 report 上，run 卡死在超时里而不是完成。
    const script = [
      "interface Plan { steps: string[]; }",
      'const planner = agent("planner");',
      'const plan = await planner.ask<Plan>("draft a plan");',
      'report({ phase: "planned", steps: plan.steps });',
      "for (const step of plan.steps) {",
      '  report({ phase: "step", step });',
      "}",
      "return plan.steps.length;",
    ].join("\n");

    const { settlement, journal, driver } = await runScript(script, {
      asks: { "ask#1": () => ({ type: "submit", payload: { steps: ["a", "b"] } }) },
    });

    expect(settlement).toEqual({ status: "completed", artifact: 2 });

    // 三条报告：report#1 一次 + report#2 两次（循环体内同一站点，ordinal 递增）。
    const reports = journal
      .listNodes(RUN, { kinds: "all", withResult: true })
      .filter((n) => n.kind === "report");
    expect(reports.map((n) => `${n.siteId}@${n.ordinal}`)).toEqual([
      "report#1@1",
      "report#2@1",
      "report#2@2",
    ]);
    // 一次写、已结算、无 actor 归属、result 即 item、inputHash 覆盖 item。
    expect(reports.every((n) => n.status === "completed" && n.actorSeq === undefined)).toBe(true);
    expect(reports[0]?.result).toEqual({ phase: "planned", steps: ["a", "b"] });
    expect(reports[0]?.inputHash).toBe(inputHash({ phase: "planned", steps: ["a", "b"] }));
    expect(reports.map((n) => n.result)).toEqual([
      { phase: "planned", steps: ["a", "b"] },
      { phase: "step", step: "a" },
      { phase: "step", step: "b" },
    ]);

    // Boundary C：每条未被跳过的报告恰好一个事件，且按到达顺序（事件通道的 FIFO 是承重的）。
    expect(driver.eventsOfType("report").map((e) => e.item)).toEqual(reports.map((n) => n.result));
  });

  it("carries the reported items even though the run fails afterwards", async () => {
    // report 存在的理由：一个死在第十二个 ask 上的 run 仍然做完了十一个 ask 的活。
    // 报告必须在 journal 里活下来，而不是随失败一起蒸发。
    const script = [
      'const scout = agent("scout");',
      'const a = await scout.ask<string>("first");',
      "report({ done: a });",
      'const b = await scout.ask<string>("second");',
      "report({ done: b });",
      "return b;",
    ].join("\n");

    const { settlement, journal } = await runScript(script, {
      asks: {
        "ask#1": () => ({ type: "text", finalText: "ok-1" }),
        "ask#2": () => ({ type: "fail", error: new WorkflowError("DriverError", "boom") }),
      },
    });

    expect(settlement.status).toBe("errored");
    const reports = journal
      .listNodes(RUN, { kinds: "all", withResult: true })
      .filter((n) => n.kind === "report");
    expect(reports).toHaveLength(1);
    expect(reports[0]?.result).toEqual({ done: "ok-1" });
  });

  it("emits nothing on replay: a resumed run never shows an item twice", async () => {
    // resume 时脚本重跑，所以每个 report 调用都会再执行一次。已 journal 的 (siteId, ordinal)
    // 静默跳过——这就是 report 与 log 的全部差别，也是它要落 journal 的唯一理由。
    const script = [
      'const scout = agent("scout");',
      'const a = await scout.ask<string>("first");',
      "report({ found: a });",
      "return a;",
    ].join("\n");

    const journal = new InMemoryJournalStore();
    const first = await runScript(script, {
      journal,
      asks: { "ask#1": () => ({ type: "text", finalText: "ok-1" }) },
    });
    expect(first.settlement.status).toBe("completed");
    expect(first.driver.eventsOfType("report")).toHaveLength(1);

    const resumed = await runScript(script, {
      journal,
      // resume 必须零派发：ask 从 journal 命中短路，report 从 journal 去重。
      onStartAsk: (instance) => {
        throw new Error(`resume 不该派发任何 ask，却派发了 ${instance.siteId}`);
      },
    });

    expect(resumed.settlement).toEqual({ status: "completed", artifact: "ok-1" });
    expect(resumed.driver.eventsOfType("report")).toEqual([]);
    expect(
      journal.listNodes(RUN, { kinds: "all", withResult: true }).filter((n) => n.kind === "report"),
    ).toHaveLength(1);
  });

  it("fails the run on the item past the 65,536-item cap, keeping every item before it", async () => {
    // 条数上限（docs/execution-engine.md「Progressive results: `report`」）走完整条沙箱链路：
    // 第 65,537 条让整个 run 失败，前 65,536 条全部落 journal；脚本的 try/catch 接不到它。
    const script = [
      "try {",
      "  for (let i = 0; i < 65537; i += 1) report(i);",
      "} catch {",
      '  return "caught";',
      "}",
      'return "not-caught";',
    ].join("\n");

    const { settlement, journal } = await runScript(script);

    expect(settlement.status).toBe("errored");
    expect((settlement as { error?: WorkflowError }).error?.code).toBe("ReportCapExceeded");
    expect(journal.countNodes(RUN, "report")).toBe(65_536);
  }, 120_000);

  it("carries an item just under the 1 MiB per-item cap through the sandbox intact", async () => {
    // 单条上限 1 MiB（docs/execution-engine.md「Progressive results: `report`」）：一条接近上限的
    // item 必须原样穿过沙箱边界、落进 journal，run 正常结束。
    const script = ['report({ n: 1, big: "y".repeat(1000000) });', 'return "done";'].join("\n");

    const { settlement, journal } = await runScript(script);

    expect(settlement).toEqual({ status: "completed", artifact: "done" });
    const [row] = journal.listNodes(RUN, { kinds: ["report"], withResult: true });
    expect(row?.result).toEqual({ n: 1, big: "y".repeat(1_000_000) });
  });

  it("fails the run when a reported item exceeds the per-item cap", async () => {
    // 上限失败的是**整个 run**（`report` 返回 void，没有可拒绝进去的通道），所以这里断言的是
    // run 结算而不是一个被 catch 的异常——脚本里那句 try/catch 什么也接不到。
    const script = [
      'const big = "x".repeat(1100000);',
      "try {",
      "  report({ big });",
      "} catch {",
      '  return "caught";',
      "}",
      'return "not-caught";',
    ].join("\n");

    const { settlement, journal } = await runScript(script);

    expect(settlement.status).toBe("errored");
    expect((settlement as { error?: WorkflowError }).error?.code).toBe("ReportCapExceeded");
    expect(
      journal.listNodes(RUN, { kinds: "all", withResult: true }).filter((n) => n.kind === "report"),
    ).toEqual([]);
  });
});

describe("e2e — Promise.race with a losing in-flight ask", () => {
  // Bug 回归（engine.complete 不中止在飞 ask）：race 胜者结算、脚本返回、子进程发 complete
  // 之后，败者的 ask 原先继续留在 liveNodes——它的 turn 在宿主进程接着跑、turn 结束还会被
  // nudge 进新一轮模型调用，node-settled/usage-updated 事件全部落在 run-settled 之后。
  // complete 现在与 cancel/failRun 一样同步 abortInFlight：败者被 driver 侧取消、
  // run-settled 是事件流最后一条。
  it("completes with the winner and aborts the loser at the driver", async () => {
    const script = [
      'const fast = agent("fast");',
      'const slow = agent("slow");',
      "const winner = await Promise.race([",
      '  fast.ask<string>("quick answer"),',
      '  slow.ask<string>("slow answer"),',
      "]);",
      "return winner;",
    ].join("\n");

    const { settlement, journal, driver } = await runScript(script, {
      asks: {
        // ask<string> 是 untyped（末轮文本即结果）：胜者以 turn-end 文本结算。
        "ask#1": () => ({
          type: "text",
          finalText: "won",
          stats: { tokens: 5, toolCalls: 0, turns: 1 },
        }),
        // 败者：无任何动作——ask 永远悬着，模拟一个仍在跑的慢 turn。
        "ask#2": () => [],
      },
    });

    expect(settlement).toEqual({ status: "completed", artifact: "won" });

    // 败者在 driver 侧被取消（宿主进程不再挂着它的 turn）。
    expect(driver.cancels.some((i) => i.siteId === "ask#2")).toBe(true);

    // 事件流不变量：run-settled 是最后一条；败者的 node-settled(cancelled) 在它之前。
    const types = driver.events.map((e) => e.type);
    expect(types.at(-1)).toBe("run-settled");
    const loserSettled = driver
      .eventsOfType("node-settled")
      .find((e) => e.instance.siteId === "ask#2");
    expect(loserSettled?.outcome).toBe("cancelled");

    // journal：胜者 completed；败者停在准入时的 running 记录（与 cancel 的 resume 语义对齐）。
    expect(journal.getNode(RUN, "ask#1", 1)?.status).toBe("completed");
    expect(journal.getNode(RUN, "ask#2", 1)?.status).toBe("running");
  });
});

// 阶段标记（docs/dynamic-workflow/presentation.md）：lowering 把 phase("…")
// 改写成 __host.enterPhase，子进程经事件通道交给引擎，引擎发 phase-entered。
describe("e2e — phase markers", () => {
  const script = [
    'phase("Prepare");',
    'const scout = agent("scout");',
    "for (let i = 0; i < 2; i++) {",
    '  phase("Ask");',
    "  await scout.ask<string>(`round ${i}`);",
    "}",
    'phase("Wrap up");',
    'return "ok";',
  ].join("\n");

  it("emits one phase-entered per evaluated marker, in evaluation order, with per-name ordinals", async () => {
    const { settlement, journal, driver } = await runScript(script, {
      asks: { "ask#1": () => ({ type: "text", finalText: "fine" }) },
    });
    expect(settlement.status).toBe("completed");
    expect(driver.eventsOfType("phase-entered")).toEqual([
      { type: "phase-entered", name: "Prepare", ordinal: 1 },
      { type: "phase-entered", name: "Ask", ordinal: 1 },
      { type: "phase-entered", name: "Ask", ordinal: 2 },
      { type: "phase-entered", name: "Wrap up", ordinal: 1 },
    ]);
    // 到达顺序承重：进入 Ask 先于它里面那次 ask 的派发。
    const order = driver.events
      .filter((e) => e.type === "phase-entered" || e.type === "node-queued")
      .map((e) =>
        e.type === "phase-entered"
          ? `phase:${e.name}@${e.ordinal}`
          : `node:${e.instance.siteId}@${e.instance.ordinal}`,
      );
    expect(order).toEqual([
      "phase:Prepare@1",
      "phase:Ask@1",
      "node:ask#1@1",
      "phase:Ask@2",
      "node:ask#1@2",
      "phase:Wrap up@1",
    ]);
    // 标记不是站点：journal 里没有它的行。
    expect(journal.listNodes(RUN, { kinds: "all", withResult: true }).map((n) => n.kind)).toEqual([
      "ask",
      "ask",
    ]);
  });

  it("re-emits the prefix on resume (no journal row to dedupe against); consumers reduce monotonically", async () => {
    const journal = new InMemoryJournalStore();
    const first = await runScript(script, {
      journal,
      asks: { "ask#1": () => ({ type: "text", finalText: "fine" }) },
    });
    expect(first.settlement.status).toBe("completed");
    const resumed = await runScript(script, {
      journal,
      onStartAsk: (instance) => {
        throw new Error(`resume 不该派发任何 ask，却派发了 ${instance.siteId}`);
      },
    });
    expect(resumed.settlement.status).toBe("completed");
    expect(resumed.driver.eventsOfType("phase-entered")).toEqual(
      first.driver.eventsOfType("phase-entered"),
    );
  });
});
