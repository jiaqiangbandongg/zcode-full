/**
 * 修复原因：journal-contract.ts 顶到 oxlint max-lines 上限（400 行），把run 记录（建 run / 结算袋 / 元数据列 / 用量）的用例拆到本文件；
 * 公开面仍从 journal-contract.ts 导出（`runJournalStoreContract` 按原顺序调用各主题的注册函数）。
 *
 * 注意：这里只登记 `it(...)`，不另开 describe——套件的分组与用例顺序必须与拆分前逐字相同。
 */

import { expect, it } from "vitest";
import type { JournalStorePort } from "../engine/index.js";
import { baseRun } from "./journal-contract-helpers.js";

export function registerRunCases(factory: () => JournalStorePort): void {
  it("creates and reads back a run record", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    expect(store.getRun("r1")).toMatchObject({ runId: "r1", status: "running", spentTokens: 0 });
    expect(store.getRun("missing")).toBeUndefined();
  });

  it("rejects duplicate run creation loudly", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    expect(() => store.createRun(baseRun("r1"))).toThrow();
  });

  it("updates run status and failure", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    store.updateRunStatus("r1", "errored", {
      failure: { code: "ReportCapExceeded", message: "cap" },
    });
    const run = store.getRun("r1");
    expect(run?.status).toBe("errored");
    expect(run?.failure).toEqual({ code: "ReportCapExceeded", message: "cap" });
    expect(run?.stopReason).toBeUndefined();
  });

  // 三终态（docs/execution-engine.md）：stopped 随 stopReason 一笔写，
  // provider / interrupted 带 failure，user / model 不带。两个实现读回来必须逐字段一致——
  // SQLite 侧物理列仍是旧词（cancelled + failure_json 信封），编解码是它自己的事。
  it("settles a stopped run with its reason and a ProviderStop failure", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    const failure = {
      code: "ProviderStop" as const,
      message: "Sign-in to BigModel expired.",
      providerStop: {
        kind: "auth" as const,
        reason: "auth_failed",
        providerId: "account:bigmodel-coding-plan",
        modelId: "GLM-5.3",
        providerCode: "1006",
        subagent: "verify@2",
        phase: "Verify",
        rawMessage: "[1006] token expired",
      },
    };
    store.updateRunStatus("r1", "stopped", { stopReason: "provider", failure });
    const run = store.getRun("r1");
    expect(run?.status).toBe("stopped");
    expect(run?.stopReason).toBe("provider");
    expect(run?.failure).toEqual(failure);
    expect(run?.result).toBeUndefined();
  });

  it("settles a stopped run without a failure and reads the reason back", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    store.updateRunStatus("r1", "stopped", { stopReason: "model" });
    const run = store.getRun("r1");
    expect(run?.status).toBe("stopped");
    expect(run?.stopReason).toBe("model");
    expect(run?.failure).toBeUndefined();
  });

  it("settles an interrupted run with its Interrupted failure", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    store.updateRunStatus("r1", "stopped", {
      stopReason: "interrupted",
      failure: { code: "Interrupted", message: "owner process exited" },
    });
    const run = store.getRun("r1");
    expect(run?.status).toBe("stopped");
    expect(run?.stopReason).toBe("interrupted");
    expect(run?.failure?.code).toBe("Interrupted");
  });

  // 结算袋存在的理由：终态与产物必须一笔写。分两笔写会开出一个崩溃窗口，
  // 造出「completed 但产物不可恢复」的 run。
  it("settles a completed run together with its artifact", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    store.updateRunStatus("r1", "completed", { result: { answer: 42, notes: ["a", "b"] } });
    const run = store.getRun("r1");
    expect(run?.status).toBe("completed");
    expect(run?.result).toEqual({ answer: 42, notes: ["a", "b"] });
    expect(run?.failure).toBeUndefined();
  });

  // 产物是脚本的顶层返回值——任意 JSON 值，不只是 record。
  it.each([
    ["a string artifact", "plain text answer"],
    ["an array artifact", [1, "two", { three: true }]],
    ["a number artifact", 7],
    ["a boolean artifact", false],
    // `null` 是合法产物，必须原样回来，而不是塌成「没有 result」。
    ["a null artifact", null],
  ])("round-trips %s", (_label, artifact) => {
    const store = factory();
    store.createRun(baseRun("r1"));
    store.updateRunStatus("r1", "completed", { result: artifact });
    const run = store.getRun("r1");
    expect(run?.status).toBe("completed");
    expect("result" in (run ?? {})).toBe(true);
    expect(run?.result).toEqual(artifact);
  });

  it("leaves result absent for an errored settlement", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    store.updateRunStatus("r1", "errored", { failure: { code: "DriverError", message: "boom" } });
    const run = store.getRun("r1");
    expect(run?.status).toBe("errored");
    expect(run?.failure).toEqual({ code: "DriverError", message: "boom" });
    expect(run?.result).toBeUndefined();
  });

  // 结算袋缺省 = 「不触碰 failure 与 result」。既覆盖引擎自己的 `running` 写入，
  // 也覆盖 0020 之前落库的历史行。
  it("leaves result absent when no settlement bag is passed", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    store.updateRunStatus("r1", "completed");
    expect(store.getRun("r1")!.result).toBeUndefined();
    expect(store.getRun("r1")?.status).toBe("completed");
  });

  // 规则三的存储侧（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Engine ownership」）。
  // Bug 根因（2026-09-04）：第二个桌面实例的孤儿收敛在本进程引擎仍活着的 run 上写下终态失败，
  // 引擎随后正常 completed——而「缺席 = 不触碰」的旧语义（SQLite 的 coalesce）让那份外来失败
  // 原样留下，行同时说「完成了」和「被打断了」。失败三件套因此**整体改写**，产物不变。
  it("clears a stale failure when a later settlement completes the run", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    store.updateRunStatus("r1", "stopped", {
      stopReason: "interrupted",
      failure: { code: "Interrupted", message: "foreign reconcile" },
    });
    store.updateRunStatus("r1", "completed", { result: { done: true } });
    const run = store.getRun("r1");
    expect(run?.status).toBe("completed");
    expect(run?.failure).toBeUndefined();
    expect(run?.stopReason).toBeUndefined();
    expect(run?.result).toEqual({ done: true });
  });

  it("clears an errored failure when a later settlement completes the run", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    store.updateRunStatus("r1", "errored", { failure: { code: "DriverError", message: "boom" } });
    store.updateRunStatus("r1", "completed", { result: { done: true } });
    const run = store.getRun("r1");
    expect(run?.status).toBe("completed");
    expect(run?.failure).toBeUndefined();
    expect(run?.result).toEqual({ done: true });
  });

  it("keeps an already-settled artifact when a later write omits it", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    store.updateRunStatus("r1", "completed", { result: { kept: true } });
    store.updateRunStatus("r1", "completed");
    expect(store.getRun("r1")!.result).toEqual({ kept: true });
  });

  // amend 停下的前驱：`superseded` 与后继 id 同一笔落库、同一封 envelope 读回
  // （docs/execution-engine.md「Amend-resume」）。少了嗅探白名单里的那个值，整封解不出来、行退化成 user。
  it("round-trips stopped(superseded) together with supersededBy", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    store.updateRunStatus("r1", "stopped", { stopReason: "superseded", supersededBy: "r2" });
    const run = store.getRun("r1");
    expect(run?.status).toBe("stopped");
    expect(run?.stopReason).toBe("superseded");
    expect(run?.supersededBy).toBe("r2");
    expect(run?.failure).toBeUndefined();
    // 其余原因不带后继指针。
    store.createRun(baseRun("r3"));
    store.updateRunStatus("r3", "stopped", { stopReason: "model" });
    expect(store.getRun("r3")?.supersededBy).toBeUndefined();
  });

  // resume 语义：把 run 翻回非终态时，上一世的 settlement 残留必须一并清空。
  // 引擎的 resume 分支写的是 `updateRunStatus(runId, "running")`（无结算袋），而
  // 「缺席键 = 不触碰」的终态语义会让一个被孤儿收敛成 failed+Interrupted 的 run
  // 恢复后带着陈旧的 failure_json 与 running 并存——journal 快照读面会同时报告
  // 「在跑」和「已失败」。所以非终态写入的语义是**清空**，不是保留。
  it("clears failure and stopReason when flipping a stopped run back to a non-terminal status", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    store.updateRunStatus("r1", "stopped", {
      stopReason: "interrupted",
      failure: { code: "Interrupted", message: "killed" },
    });
    store.updateRunStatus("r1", "running");
    const run = store.getRun("r1");
    expect(run?.status).toBe("running");
    expect(run?.failure).toBeUndefined();
    expect(run?.stopReason).toBeUndefined();
    expect(run?.supersededBy).toBeUndefined();
  });

  it("clears result when flipping a completed run back to a non-terminal status", () => {
    // completed run 不在可恢复集里，但端口语义按状态类别定义、不按调用方好恶：
    // 非终态 = 无 settlement。让语义带例外只会把门的知识泄漏进存储层。
    const store = factory();
    store.createRun(baseRun("r1"));
    store.updateRunStatus("r1", "completed", { result: { stale: true } });
    store.updateRunStatus("r1", "pending");
    const run = store.getRun("r1");
    expect(run?.status).toBe("pending");
    expect(run?.result).toBeUndefined();
  });

  it("ignores a settlement bag on a non-terminal write (cleared, not stored)", () => {
    // 非终态携带结算袋是调用方的矛盾请求：一个「在跑」的 run 没有结算。语义定为清空优先，
    // 免得两个实现对这个矛盾各自发明不同的解释。
    const store = factory();
    store.createRun(baseRun("r1"));
    store.updateRunStatus("r1", "running", { failure: { code: "DriverError", message: "x" } });
    expect(store.getRun("r1")?.failure).toBeUndefined();
  });

  // createRun 也要认这个字段：内存实现整条克隆记录，SQLite 若不写这一列，同一个 record
  // 存进两个实现再读回来就会分叉。引擎只以 running 建 run，但端口的语义不该有这个洞。
  it("creates and reads back a run carrying an artifact", () => {
    const store = factory();
    store.createRun({ ...baseRun("r1"), status: "completed", result: { seeded: true } });
    expect(store.getRun("r1")!.result).toEqual({ seeded: true });
  });

  // name 是 run 的展示标签（`input.name` → createRun → dwf_run.name），与 scriptText/cwd 同一条
  // 元数据路。两个实现都有 createRun/getRun，所以它属于契约：SQLite 若漏写这一列，同一条
  // record 存进两个实现再读回来就会分叉（result 列当年逐字同一条论证）。
  it("round-trips a run name and keeps it absent when unnamed", () => {
    const store = factory();
    store.createRun({ ...baseRun("named"), name: "nightly triage" });
    store.createRun(baseRun("unnamed"));

    expect(store.getRun("named")?.name).toBe("nightly triage");
    const unnamed = store.getRun("unnamed");
    expect(unnamed?.name).toBeUndefined();
    // 缺席的可选字段必须原样缺席地回来，而不是变成 name: null / name: undefined。
    expect(unnamed !== undefined && "name" in unnamed).toBe(false);
  });

  // 实参（`dwf_run.args_json`，migration 0026）与 scriptText / name 同一条 createRun
  // 元数据路，属于契约的理由更硬：resume **重放**存下来的实参，所以 SQLite 若漏写这一列，
  // 恢复出来的 run 会带着 `{}` 静默跑一遍——「批准的是 A、恢复的是 B」。
  it("round-trips the run args and keeps them absent when the run had none", () => {
    const store = factory();
    store.createRun({
      ...baseRun("with-args"),
      args: { target: "packages/core", depth: 3, nested: { deep: true } },
    });
    store.createRun(baseRun("no-args"));

    expect(store.getRun("with-args")?.args).toEqual({
      target: "packages/core",
      depth: 3,
      nested: { deep: true },
    });
    const bare = store.getRun("no-args");
    // 缺席的可选字段原样缺席地回来（0026 之前的老行走的正是这条路）：记录层面「没有
    // 实参」与「实参是空袋」保持可分辨，沙箱侧才统一把缺席读作 `{}`。
    expect(bare?.args).toBeUndefined();
    expect(bare !== undefined && "args" in bare).toBe(false);
  });

  it("keeps the run args across a status settlement", () => {
    const store = factory();
    store.createRun({ ...baseRun("r-args"), args: { keep: "me" } });
    store.updateRunStatus("r-args", "completed", { result: "done" });
    // resume 能读回它，是因为结算那条 UPDATE 不碰这一列。
    expect(store.getRun("r-args")?.args).toEqual({ keep: "me" });
  });

  // 结算只改状态与产物：name 不在 updateRunStatus 的写入面上（SQLite 侧那条 UPDATE 若把
  // name 列进去，run 一结算就会丢名字）。
  it("keeps the run name across a status settlement", () => {
    const store = factory();
    store.createRun({ ...baseRun("r1"), name: "keeps its name" });
    store.updateRunStatus("r1", "completed", { result: "done" });
    expect(store.getRun("r1")?.name).toBe("keeps its name");
  });

  // toolCallId 是发起 run 的 CreateWorkflow 工具调用 id——重启后工具卡 join 与 resume
  // 的持久锚点（docs/execution-engine.md）。它与 scriptText/cwd 走同一条
  // createRun 元数据路，属于契约：SQLite 若漏写这一列，重启后的发现查询拿不回关联键。
  it("round-trips the originating toolCallId and keeps it absent when not given", () => {
    const store = factory();
    store.createRun({ ...baseRun("anchored"), toolCallId: "call-42" });
    store.createRun(baseRun("bare"));

    expect(store.getRun("anchored")?.toolCallId).toBe("call-42");
    const bare = store.getRun("bare");
    expect(bare?.toolCallId).toBeUndefined();
    // 缺席的可选字段必须原样缺席地回来，而不是变成 toolCallId: null / undefined。
    expect(bare !== undefined && "toolCallId" in bare).toBe(false);
  });

  // 结算只改状态与产物：toolCallId 不在 updateRunStatus 的写入面上。
  it("keeps the toolCallId across a status settlement and across a resume flip", () => {
    const store = factory();
    store.createRun({ ...baseRun("r1"), toolCallId: "call-7" });
    store.updateRunStatus("r1", "stopped", { stopReason: "user" });
    expect(store.getRun("r1")?.toolCallId).toBe("call-7");
    // resume 把 run 翻回 running 清的是 settlement，锚点必须原样保留。
    store.updateRunStatus("r1", "running");
    expect(store.getRun("r1")?.toolCallId).toBe("call-7");
  });

  // resumedFrom 是 amend-resume 的 lineage 指针（本 run 修订自哪个前驱 run，
  // docs/execution-engine.md）。与 toolCallId / args 同一条 createRun 元数据路，
  // 属于契约的理由是它是**存续依赖**：修订 run 崩溃后的 plain resume 靠读回这个指针重建
  // ImportedCache，SQLite 若漏写这一列，恢复出来的 run 会把全部未消费的缓存降级成 live 重跑。
  it("round-trips the resumedFrom lineage pointer and keeps it absent for a fresh run", () => {
    const store = factory();
    store.createRun({ ...baseRun("amended"), resumedFrom: "run-predecessor" });
    store.createRun(baseRun("fresh"));

    expect(store.getRun("amended")?.resumedFrom).toBe("run-predecessor");
    const fresh = store.getRun("fresh");
    expect(fresh?.resumedFrom).toBeUndefined();
    // 缺席的可选字段必须原样缺席地回来（NULL 解码成缺席的键，不是 null / undefined）——
    // 绝大多数 run 不是修订，这条才是常态路径。
    expect(fresh !== undefined && "resumedFrom" in fresh).toBe(false);
  });

  // 结算与 resume 翻转都不在 lineage 的写入面上：链式修订要沿着这个指针回溯任意深度的
  // 祖先，任何一环在结算时丢掉指针，链就断在那里。
  it("keeps resumedFrom across a status settlement and across a resume flip", () => {
    const store = factory();
    store.createRun({ ...baseRun("r1"), resumedFrom: "run-a" });
    store.updateRunStatus("r1", "stopped", { stopReason: "user" });
    expect(store.getRun("r1")?.resumedFrom).toBe("run-a");
    store.updateRunStatus("r1", "running");
    expect(store.getRun("r1")?.resumedFrom).toBe("run-a");
  });

  it("isolates a stored artifact from later mutation of the caller's object", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    const artifact = { nested: { value: 1 } };
    store.updateRunStatus("r1", "completed", { result: artifact });
    artifact.nested.value = 999;
    // r1 两行前刚 createRun，getRun 必命中；用非空断言代替 ?.，否则其后的 .nested.value 链式
    // 访问在 lint 眼里是 unsafe optional chaining（?. 短路成 undefined 时会直接 throw）。
    expect((store.getRun("r1")!.result as { nested: { value: number } }).nested.value).toBe(1);
  });

  it("settles an artifact and a failure independently on separate runs", () => {
    const store = factory();
    store.createRun(baseRun("ok"));
    store.createRun(baseRun("bad"));
    store.updateRunStatus("ok", "completed", { result: "done" });
    store.updateRunStatus("bad", "errored", {
      failure: { code: "DriverError", message: "stop" },
    });
    expect(store.getRun("ok")?.result).toBe("done");
    expect(store.getRun("ok")?.failure).toBeUndefined();
    expect(store.getRun("bad")?.result).toBeUndefined();
    expect(store.getRun("bad")?.failure?.code).toBe("DriverError");
  });

  it("throws when updating an unknown run", () => {
    const store = factory();
    expect(() => store.updateRunStatus("nope", "completed")).toThrow();
  });

  it("persists accumulated usage without disturbing status or failure", () => {
    // 用量是 run 结算之外的独立写入路径：askStats 每次累加都要落库，
    // 否则 resume 会从零用量重来（阶段 1.5 的潜伏 bug）。
    const store = factory();
    store.createRun(baseRun("r1"));
    store.updateRunUsage("r1", 4200);
    expect(store.getRun("r1")).toMatchObject({ spentTokens: 4200, status: "running" });
    expect(store.getRun("r1")?.failure).toBeUndefined();

    // 已结算（含 failure）的 run 上再写用量，状态与失败原因不得被改写。
    store.updateRunStatus("r1", "errored", {
      failure: { code: "DriverError", message: "over" },
    });
    store.updateRunUsage("r1", 5100);
    const run = store.getRun("r1");
    expect(run?.spentTokens).toBe(5100);
    expect(run?.status).toBe("errored");
    expect(run?.failure).toEqual({ code: "DriverError", message: "over" });
  });

  it("throws when updating the usage of an unknown run", () => {
    const store = factory();
    expect(() => store.updateRunUsage("nope", 1)).toThrow();
  });

  // `caps_max_concurrency` 的**第二个写入者**（docs/dynamic-workflow/concurrency.md
  // 「Two bounds on a run」）：一次只改 `max_concurrency` 的修订就地作用在活着的 run 上，
  // 而 resume 沿用行里的 caps——不落库，恢复出来的就还是旧上界。与用量同族的窄写入：
  // 只碰这一列，状态 / 用量 / 结算袋一概不动。
  it("retunes the concurrency cap without disturbing status, usage or failure", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    store.updateRunUsage("r1", 4200);
    store.updateRunCaps("r1", { maxConcurrency: 2 });
    expect(store.getRun("r1")).toMatchObject({
      caps: { maxConcurrency: 2 },
      spentTokens: 4200,
      status: "running",
    });

    // 已结算（含 failure）的 run 上再写上界，状态与失败原因不得被改写。
    store.updateRunStatus("r1", "errored", {
      failure: { code: "DriverError", message: "over" },
    });
    store.updateRunCaps("r1", { maxConcurrency: 7 });
    const run = store.getRun("r1");
    expect(run?.caps).toEqual({ maxConcurrency: 7 });
    expect(run?.status).toBe("errored");
    expect(run?.failure).toEqual({ code: "DriverError", message: "over" });
  });

  it("throws when retuning the caps of an unknown run", () => {
    const store = factory();
    expect(() => store.updateRunCaps("nope", { maxConcurrency: 1 })).toThrow();
  });
}
