/**
 * 引擎侧的用户面产物（docs/dynamic-workflow/authoring.md「Journal rows and events」两行 + 错误码表）。
 * 编译侧在 tests/artifacts.test.ts。
 *
 * ⚠ 术语：本文件的 artifact 一律是**用户面产物**（脚本发布给用户看的产出），不是
 * `RunSettlement.artifact`（脚本的顶层返回值，那个在别的测试里叫 artifact 也很正常）。
 */

import { describe, expect, it } from "vitest";
import {
  InMemoryJournalStore,
  WorkflowEngine,
  WorkflowError,
  type ArtifactVersionRecord,
  type Caps,
} from "../../src/engine/index.js";
import { ARTIFACT_CAPS } from "../../src/facade/artifact-caps.js";
import { FakeDriver, type FakeDriverOptions } from "./fake-driver.js";

const RUN = "run";
const CHART = { x: { field: "round" }, y: { field: "ms" } };

function setup(opts: { journal?: InMemoryJournalStore; caps?: Caps } & FakeDriverOptions = {}) {
  const { journal: given, caps, ...driverOptions } = opts;
  const journal = given ?? new InMemoryJournalStore();
  const driver = new FakeDriver(journal, driverOptions);
  const engine = new WorkflowEngine({
    runId: RUN,
    driver,
    caps: caps ?? { maxConcurrency: 16 },
    askSpecs: new Map(),
    validate: () => [],
  });
  return { journal, driver, engine };
}

/** 某类事件的全部载荷（断言事件流用）。 */
const published = (driver: FakeDriver): ArtifactVersionRecord[] =>
  driver.eventsOfType("artifact-published").map((event) => event.artifact);

/** 捕获一次 run 级失败（failRun 后 settled 兑现为 errored）。 */
async function failure(engine: WorkflowEngine): Promise<WorkflowError> {
  const settlement = await engine.settled;
  if (settlement.status !== "errored")
    throw new Error(`expected errored, got ${settlement.status}`);
  return settlement.error;
}

describe("publishArtifact — 内容成员", () => {
  it("经 driver 发布、落 completed 行、发 artifact-published，并把 ref 交给脚本", async () => {
    const { engine, driver, journal } = setup();
    const ref = await engine.publishArtifact("artifact#1", "file", [
      "book",
      "out/book.pdf",
      { title: "Book" },
    ]);

    expect(ref).toEqual({ id: "book", version: 1 });
    // driver 收到的请求形状：版本号由引擎算好传下去（store 的 toolCallId 里要带它）。
    expect(driver.artifactPublishes).toEqual([
      {
        runId: RUN,
        siteId: "artifact#1",
        ordinal: 1,
        op: "file",
        id: "book",
        version: 1,
        path: "out/book.pdf",
        opts: { title: "Book" },
      },
    ]);
    const node = journal.getNode(RUN, "artifact#1", 1);
    expect(node?.kind).toBe("artifact");
    expect(node?.status).toBe("completed");
    expect(node?.artifactId).toBe("book");
    expect((node?.result as ArtifactVersionRecord | undefined)?.uri).toBe(
      "zcode-artifact://fake/book/1",
    );
    expect(published(driver).map((r) => [r.id, r.version])).toEqual([["book", 1]]);
  });

  it("同 id 再发布是新版本，版本号按已 completed 的行数派生", async () => {
    const { engine } = setup();
    const first = await engine.publishArtifact("artifact#1", "file", ["book", "a.pdf"]);
    const second = await engine.publishArtifact("artifact#1", "file", ["book", "b.pdf"]);
    expect([first.version, second.version]).toEqual([1, 2]);
  });

  it("markdown 走 content 而不是 path", async () => {
    const { engine, driver } = setup();
    await engine.publishArtifact("artifact#1", "markdown", ["notes", "# hi"]);
    expect(driver.artifactPublishes[0]?.content).toBe("# hi");
    expect(driver.artifactPublishes[0]?.path).toBeUndefined();
  });

  it("journal 命中即短路：不调 driver、不重发事件", async () => {
    const journal = new InMemoryJournalStore();
    const first = setup({ journal });
    await first.engine.publishArtifact("artifact#1", "file", ["book", "a.pdf"]);
    first.engine.complete(undefined);

    const resumed = setup({ journal });
    const ref = await resumed.engine.publishArtifact("artifact#1", "file", ["book", "a.pdf"]);
    expect(ref).toEqual({ id: "book", version: 1 });
    expect(resumed.driver.artifactPublishes).toEqual([]);
    expect(published(resumed.driver)).toEqual([]);
  });

  it("命中一条失败记录即按记录重新拒绝（resume 是崩溃恢复，不是复验）", async () => {
    const journal = new InMemoryJournalStore();
    const first = setup({ journal, withoutArtifactStore: true });
    await expect(
      first.engine.publishArtifact("artifact#1", "file", ["book", "a.pdf"]),
    ).rejects.toMatchObject({ code: "ArtifactStoreUnavailable" });
    first.engine.complete(undefined);

    // 第二次装配**有** store：记录里的失败仍然是失败，driver 不会被调到。
    const resumed = setup({ journal });
    await expect(
      resumed.engine.publishArtifact("artifact#1", "file", ["book", "a.pdf"]),
    ).rejects.toMatchObject({ code: "ArtifactStoreUnavailable" });
    expect(resumed.driver.artifactPublishes).toEqual([]);
  });

  it("版本号跨 resume 连续", async () => {
    const journal = new InMemoryJournalStore();
    const first = setup({ journal });
    await first.engine.publishArtifact("artifact#1", "file", ["book", "a.pdf"]);
    first.engine.complete(undefined);

    const resumed = setup({ journal });
    // 第一次调用重放命中（v1），第二次是新 ordinal：若版本计数没从 journal 恢复，它会是 1。
    await resumed.engine.publishArtifact("artifact#1", "file", ["book", "a.pdf"]);
    const next = await resumed.engine.publishArtifact("artifact#1", "file", ["book", "b.pdf"]);
    expect(next.version).toBe(2);
  });

  it("inputHash 失配即整个 run 失败（绝不静默偏移）", async () => {
    const journal = new InMemoryJournalStore();
    const first = setup({ journal });
    await first.engine.publishArtifact("artifact#1", "file", ["book", "a.pdf"]);
    first.engine.complete(undefined);

    const resumed = setup({ journal });
    await expect(
      resumed.engine.publishArtifact("artifact#1", "file", ["book", "OTHER.pdf"]),
    ).rejects.toMatchObject({ code: "InputHashMismatch" });
    expect((await failure(resumed.engine)).code).toBe("InputHashMismatch");
  });

  it("第 17 版被拒（节点级，脚本可 catch），run 继续活着", async () => {
    const { engine } = setup();
    for (let i = 1; i <= ARTIFACT_CAPS.maxVersionsPerArtifact; i++) {
      await engine.publishArtifact("artifact#1", "file", ["book", `v${i}.pdf`]);
    }
    await expect(
      engine.publishArtifact("artifact#1", "file", ["book", "v17.pdf"]),
    ).rejects.toMatchObject({ code: "ArtifactVersionCapExceeded" });
    expect(engine.status()).toBe("running");
  });

  it("第 33 个 id 被拒", async () => {
    const { engine } = setup();
    for (let i = 1; i <= ARTIFACT_CAPS.maxArtifactsPerRun; i++) {
      await engine.publishArtifact("artifact#1", "markdown", [`doc${i}`, "x"]);
    }
    await expect(
      engine.publishArtifact("artifact#1", "markdown", ["overflow", "x"]),
    ).rejects.toMatchObject({ code: "ArtifactCapExceeded" });
  });

  it("跨成员种类复用一个 id 是节点级拒绝", async () => {
    const { engine } = setup();
    await engine.publishArtifact("artifact#1", "file", ["x", "a.pdf"]);
    await expect(
      engine.publishArtifact("artifact#2", "markdown", ["x", "hi"]),
    ).rejects.toMatchObject({ code: "ArtifactKindMismatch" });
    expect(engine.status()).toBe("running");
  });

  it("装配没有产物存储时大声拒绝，并把失败落 journal", async () => {
    const { engine, journal, driver } = setup({ withoutArtifactStore: true });
    await expect(
      engine.publishArtifact("artifact#1", "file", ["book", "a.pdf"]),
    ).rejects.toMatchObject({ code: "ArtifactStoreUnavailable" });
    const node = journal.getNode(RUN, "artifact#1", 1);
    expect(node?.status).toBe("failed");
    expect(node?.error?.code).toBe("ArtifactStoreUnavailable");
    expect(node?.artifactId).toBe("book");
    // 失败发自己的事件，带着渲染一张失败卡要的东西。
    expect(published(driver)).toEqual([]);
    expect(driver.eventsOfType("artifact-failed")).toEqual([
      {
        type: "artifact-failed",
        instance: { siteId: "artifact#1", ordinal: 1 },
        id: "book",
        op: "file",
        error: node?.error,
      },
    ]);
  });

  // 2026-09-04 裁决：产物站点不进任何图，所以一条 node-settled 落在它上面会在 run 面板里
  // 变成未知节点（投影把 node-settled 归约进 nodes[]，图层再按 site id 找不到它）。
  it("失败**不**发 node-settled——产物站点在图里没有节点可结算", async () => {
    const { engine, driver } = setup({ withoutArtifactStore: true });
    await expect(
      engine.publishArtifact("artifact#1", "file", ["book", "a.pdf"]),
    ).rejects.toMatchObject({ code: "ArtifactStoreUnavailable" });
    expect(driver.eventsOfType("node-settled")).toEqual([]);
    expect(driver.eventsOfType("node-queued")).toEqual([]);
    expect(driver.eventsOfType("node-dispatched")).toEqual([]);
  });

  // 成功那侧的对偶（与 report 的 parity 是有意的）：只有 artifact-published，没有节点生命周期。
  it("成功也只发 artifact-published，不发任何节点生命周期事件", async () => {
    const { engine, driver } = setup();
    await engine.publishArtifact("artifact#1", "file", ["book", "a.pdf"]);
    expect(driver.eventsOfType("artifact-published")).toHaveLength(1);
    for (const type of ["node-queued", "node-dispatched", "node-settled"] as const) {
      expect(driver.eventsOfType(type)).toEqual([]);
    }
  });

  it("replay 命中一条失败记录不重发事件", async () => {
    const journal = new InMemoryJournalStore();
    const first = setup({ journal, withoutArtifactStore: true });
    await expect(
      first.engine.publishArtifact("artifact#1", "file", ["book", "a.pdf"]),
    ).rejects.toMatchObject({ code: "ArtifactStoreUnavailable" });
    first.engine.complete(undefined);

    const resumed = setup({ journal });
    await expect(
      resumed.engine.publishArtifact("artifact#1", "file", ["book", "a.pdf"]),
    ).rejects.toMatchObject({ code: "ArtifactStoreUnavailable" });
    expect(resumed.driver.eventsOfType("artifact-failed")).toEqual([]);
    expect(resumed.driver.eventsOfType("artifact-published")).toEqual([]);
  });

  // 实参形状的护栏是**确定性**的拒绝：结论只由 args 决定，没有 driver 往返，所以既不落行
  // 也不发事件——没有 id 可写，编一个出来会让读者以为真有那么一个产物。
  it("实参形状错误直接拒绝，不落行也不发事件", async () => {
    const { engine, journal, driver } = setup();
    await expect(
      engine.publishArtifact("artifact#1", "file", [42, "a.pdf"]),
    ).rejects.toMatchObject({ code: "DriverError" });
    await expect(
      engine.publishArtifact("artifact#2", "markdown", ["notes", 7]),
    ).rejects.toMatchObject({ code: "DriverError" });
    expect(
      journal
        .listNodes(RUN, { kinds: "all", withResult: true })
        .filter((n) => n.kind === "artifact"),
    ).toEqual([]);
    expect(driver.eventsOfType("artifact-failed")).toEqual([]);
  });

  it("driver 拒绝即节点 failed + 可 catch 的结构化错误", async () => {
    const { engine, journal, driver } = setup({ deferArtifactPublishes: true });
    const promise = engine.publishArtifact("artifact#1", "file", ["book", "missing.pdf"]);
    driver.artifactDeferrals[0]?.reject(
      new WorkflowError("ArtifactSourceMissing", "out/book.pdf 不存在"),
    );
    await expect(promise).rejects.toMatchObject({ code: "ArtifactSourceMissing" });
    expect(journal.getNode(RUN, "artifact#1", 1)?.status).toBe("failed");
    expect(driver.eventsOfType("artifact-failed").map((e) => [e.id, e.op, e.error.code])).toEqual([
      ["book", "file", "ArtifactSourceMissing"],
    ]);
    expect(engine.status()).toBe("running");
  });

  it("一个失败的发布不占用 id 名额，重试仍是第 1 版", async () => {
    const { engine, driver } = setup({ deferArtifactPublishes: true });
    const first = engine.publishArtifact("artifact#1", "file", ["book", "missing.pdf"]);
    driver.artifactDeferrals[0]?.reject(new WorkflowError("ArtifactSourceMissing", "no"));
    await expect(first).rejects.toMatchObject({ code: "ArtifactSourceMissing" });

    const second = engine.publishArtifact("artifact#1", "file", ["book", "now-there.pdf"]);
    driver.artifactDeferrals[1]?.resolve({ id: "book", kind: "file", version: 1 });
    expect(await second).toEqual({ id: "book", version: 1 });
  });
});

describe("primary（docs/dynamic-workflow/authoring.md「Ids, tags and versions」）", () => {
  it("引擎把旗子盖到记录上，事件与 journal 行都带着它", async () => {
    const { engine, driver, journal } = setup();
    await engine.publishArtifact("artifact#1", "file", ["book", "a.pdf", { primary: true }]);
    expect(published(driver)[0]?.primary).toBe(true);
    expect(journal.getNode(RUN, "artifact#1", 1)?.result).toMatchObject({ primary: true });
    // 没标的记录**没有**这个键（缺席不是 false）。
    await engine.publishArtifact("artifact#2", "file", ["notes", "n.pdf"]);
    expect("primary" in (published(driver)[1] ?? {})).toBe(false);
  });

  it("按 id 粘着：下一版没再写 primary 也还是 primary", async () => {
    const { engine, driver } = setup();
    await engine.publishArtifact("artifact#1", "file", ["book", "a.pdf", { primary: true }]);
    await engine.publishArtifact("artifact#1", "file", ["book", "b.pdf"]);
    expect(published(driver).map((r) => [r.version, r.primary])).toEqual([
      [1, true],
      [2, true],
    ]);
  });

  it("第二个 id 想当 primary 是节点级拒绝：失败行 + artifact-failed，run 继续活着", async () => {
    const { engine, driver, journal } = setup();
    await engine.publishArtifact("artifact#1", "file", ["book", "a.pdf", { primary: true }]);
    await expect(
      engine.publishArtifact("artifact#2", "markdown", ["notes", "hi", { primary: true }]),
    ).rejects.toMatchObject({ code: "ArtifactPrimaryConflict" });
    expect(journal.getNode(RUN, "artifact#2", 1)?.status).toBe("failed");
    expect(driver.eventsOfType("artifact-failed")).toHaveLength(1);
    expect(engine.status()).toBe("running");
    // 输的那个没占 id：之后不带旗子再发，是它的第 1 版。
    const ref = await engine.publishArtifact("artifact#2", "markdown", ["notes", "hi"]);
    expect(ref.version).toBe(1);
  });

  it("并发的两个 primary 发布都过了准入，结算时后到的那个走失败路径", async () => {
    const { engine, driver } = setup();
    const results = await Promise.allSettled([
      engine.publishArtifact("artifact#1", "file", ["a", "a.pdf", { primary: true }]),
      engine.publishArtifact("artifact#2", "file", ["b", "b.pdf", { primary: true }]),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    expect(published(driver).map((r) => r.id)).toEqual(["a"]);
    expect(driver.eventsOfType("artifact-failed")[0]?.error.code).toBe("ArtifactPrimaryConflict");
  });

  it("失败记录 replay 照旧拒绝，且不认领旗子", async () => {
    const journal = new InMemoryJournalStore();
    const first = setup({ journal });
    await first.engine.publishArtifact("artifact#1", "file", ["book", "a.pdf", { primary: true }]);
    await expect(
      first.engine.publishArtifact("artifact#2", "file", ["other", "o.pdf", { primary: true }]),
    ).rejects.toMatchObject({ code: "ArtifactPrimaryConflict" });
    first.engine.complete(undefined);

    const resumed = setup({ journal });
    await resumed.engine.publishArtifact("artifact#1", "file", ["book", "a.pdf", { primary: true }]);
    await expect(
      resumed.engine.publishArtifact("artifact#2", "file", ["other", "o.pdf", { primary: true }]),
    ).rejects.toMatchObject({ code: "ArtifactPrimaryConflict" });
    // resume 重建：book 仍是 primary，所以第三个 id 也被拒。
    await expect(
      resumed.engine.publishArtifact("artifact#3", "file", ["third", "t.pdf", { primary: true }]),
    ).rejects.toMatchObject({ code: "ArtifactPrimaryConflict" });
    expect(resumed.driver.artifactPublishes).toEqual([]);
  });

  it("非布尔的 primary 是确定性护栏：DriverError，不落行、不发事件", async () => {
    const { engine, driver, journal } = setup();
    await expect(
      engine.publishArtifact("artifact#1", "file", ["book", "a.pdf", { primary: "yes" }]),
    ).rejects.toMatchObject({ code: "DriverError" });
    expect(journal.getNode(RUN, "artifact#1", 1)).toBeUndefined();
    expect(driver.eventsOfType("artifact-failed")).toEqual([]);
  });

  it("预置也能当 primary：记录带旗子；第二个 id 再标是 failRun", async () => {
    const { engine, driver } = setup();
    engine.declareArtifact("artifact#1", "board", [
      "triage",
      { key: "id", status: "s", columns: ["x"], primary: true },
    ]);
    expect(published(driver)[0]?.primary).toBe(true);
    engine.declareArtifact("artifact#2", "chart", ["perf", { ...CHART, primary: true }]);
    expect((await failure(engine)).code).toBe("ArtifactPrimaryConflict");
  });

  it("内容 primary 在前，预置再标 primary 也是 failRun", async () => {
    const { engine } = setup();
    await engine.publishArtifact("artifact#1", "file", ["book", "a.pdf", { primary: true }]);
    engine.declareArtifact("artifact#2", "chart", ["perf", { ...CHART, primary: true }]);
    expect((await failure(engine)).code).toBe("ArtifactPrimaryConflict");
  });

  it("spec 里非布尔的 primary 是 ArtifactSpecInvalid", async () => {
    const { engine } = setup();
    engine.declareArtifact("artifact#1", "chart", ["perf", { ...CHART, primary: 1 }]);
    const err = await failure(engine);
    expect(err.code).toBe("ArtifactSpecInvalid");
    expect(err.message).toContain("primary must be a boolean");
  });
});

describe("declareArtifact — 预置成员", () => {
  it("落一行 completed、发 artifact-published，spec 与 title 都在记录里", () => {
    const { engine, driver, journal } = setup();
    engine.declareArtifact("artifact#1", "chart", ["perf", { ...CHART, title: "性能" }]);

    const node = journal.getNode(RUN, "artifact#1", 1);
    expect(node?.kind).toBe("artifact");
    expect(node?.status).toBe("completed");
    expect(node?.artifactId).toBe("perf");
    const record = node?.result as ArtifactVersionRecord;
    expect(record).toMatchObject({ id: "perf", kind: "chart", version: 1, title: "性能" });
    expect(record.spec).toEqual({ ...CHART, title: "性能" });
    expect(published(driver)).toHaveLength(1);
  });

  it("不经 driver", () => {
    const { engine, driver } = setup();
    engine.declareArtifact("artifact#1", "table", ["rows", { columns: [{ field: "n" }] }]);
    expect(driver.artifactPublishes).toEqual([]);
  });

  it("同 id 同 spec 重复声明是幂等 no-op：不落新行、不发事件", () => {
    const { engine, driver, journal } = setup();
    engine.declareArtifact("artifact#1", "chart", ["perf", CHART]);
    engine.declareArtifact("artifact#2", "chart", ["perf", { ...CHART }]);
    expect(published(driver)).toHaveLength(1);
    expect(journal.getNode(RUN, "artifact#2", 1)).toBeUndefined();
    expect(
      journal
        .listNodes(RUN, { kinds: "all", withResult: true })
        .filter((n) => n.kind === "artifact"),
    ).toHaveLength(1);
  });

  it("同 id 异 spec 让整个 run 失败（void 返回没有拒绝通道）", async () => {
    const { engine } = setup();
    engine.declareArtifact("artifact#1", "chart", ["perf", CHART]);
    engine.declareArtifact("artifact#2", "chart", [
      "perf",
      { x: { field: "round" }, y: { field: "OTHER" } },
    ]);
    expect((await failure(engine)).code).toBe("ArtifactRedeclared");
  });

  it("spec 形状不合法即 failRun，消息说得出哪里不对", async () => {
    const { engine } = setup();
    engine.declareArtifact("artifact#1", "chart", ["perf", { x: { field: "" }, y: CHART.y }]);
    const error = await failure(engine);
    expect(error.code).toBe("ArtifactSpecInvalid");
    expect(error.message).toContain("x.field");
  });

  it("每一种预置都按自己的必填字段校验", async () => {
    const cases: Array<[Parameters<WorkflowEngine["declareArtifact"]>[1], unknown]> = [
      ["chart", { x: { field: "r" } }],
      ["table", { columns: [] }],
      ["metrics", { metrics: "not a list" }],
      ["board", { key: "id", status: "s", columns: [] }],
    ];
    for (const [op, spec] of cases) {
      const { engine } = setup();
      engine.declareArtifact("artifact#1", op, ["x", spec]);
      expect((await failure(engine)).code).toBe("ArtifactSpecInvalid");
    }
  });

  it("board 的两个标题各自校验：title 是板子的名字，cardTitle 是字段名", async () => {
    const good = setup();
    good.engine.declareArtifact("artifact#1", "board", [
      "b",
      { title: "内存回归", key: "id", status: "state", columns: ["todo"], cardTitle: "name" },
    ]);
    expect(good.engine.status()).toBe("running");

    const bad = setup();
    bad.engine.declareArtifact("artifact#1", "board", [
      "b",
      { key: "id", status: "state", columns: ["todo"], cardTitle: "" },
    ]);
    const error = await failure(bad.engine);
    expect(error.code).toBe("ArtifactSpecInvalid");
    expect(error.message).toContain("cardTitle");
  });

  it("超长 title 与超大 spec 都算 spec 不合法", async () => {
    const long = setup();
    long.engine.declareArtifact("artifact#1", "chart", [
      "perf",
      { ...CHART, title: "x".repeat(ARTIFACT_CAPS.maxTitleLength + 1) },
    ]);
    expect((await failure(long.engine)).code).toBe("ArtifactSpecInvalid");

    const big = setup();
    big.engine.declareArtifact("artifact#1", "table", [
      "rows",
      { columns: [{ field: "n", label: "y".repeat(ARTIFACT_CAPS.maxSpecSerializedBytes + 1) }] },
    ]);
    expect((await failure(big.engine)).code).toBe("ArtifactSpecInvalid");
  });

  it("预置与内容共用一个 id 是 failRun（预置族没有拒绝通道）", async () => {
    const { engine } = setup();
    await engine.publishArtifact("artifact#1", "markdown", ["x", "hi"]);
    engine.declareArtifact("artifact#2", "chart", ["x", CHART]);
    expect((await failure(engine)).code).toBe("ArtifactKindMismatch");
  });

  it("第 33 个 id 让 run 失败", async () => {
    const { engine } = setup();
    for (let i = 1; i <= ARTIFACT_CAPS.maxArtifactsPerRun; i++) {
      engine.declareArtifact(`artifact#${i}`, "chart", [`c${i}`, CHART]);
    }
    engine.declareArtifact("artifact#33", "chart", ["overflow", CHART]);
    expect((await failure(engine)).code).toBe("ArtifactCapExceeded");
  });

  it("replay 命中即静默跳过", () => {
    const journal = new InMemoryJournalStore();
    const first = setup({ journal });
    first.engine.declareArtifact("artifact#1", "chart", ["perf", CHART]);
    first.engine.complete(undefined);

    const resumed = setup({ journal });
    resumed.engine.declareArtifact("artifact#1", "chart", ["perf", CHART]);
    expect(published(resumed.driver)).toEqual([]);
    expect(
      journal
        .listNodes(RUN, { kinds: "all", withResult: true })
        .filter((n) => n.kind === "artifact"),
    ).toHaveLength(1);
  });

  it("resume 之后仍然认得这个 id 已被声明（幂等与标签都靠它）", async () => {
    const journal = new InMemoryJournalStore();
    const first = setup({ journal });
    first.engine.declareArtifact("artifact#1", "chart", ["perf", CHART]);
    first.engine.complete(undefined);

    const resumed = setup({ journal });
    resumed.engine.report("report#1", { round: 1 }, "perf");
    expect(resumed.driver.eventsOfType("report")[0]?.artifactId).toBe("perf");
    expect(resumed.engine.status()).toBe("running");
  });
});

describe("report 的产物标签", () => {
  it("标签落在节点行与事件上", () => {
    const { engine, driver, journal } = setup();
    engine.declareArtifact("artifact#1", "chart", ["perf", CHART]);
    engine.report("report#1", { round: 1, ms: 12 }, "perf");

    expect(journal.getNode(RUN, "report#1", 1)?.artifactId).toBe("perf");
    const event = driver.eventsOfType("report")[0];
    expect(event?.artifactId).toBe("perf");
    expect(event?.item).toEqual({ round: 1, ms: 12 });
  });

  it("无标签的 report 不长出 artifactId 键", () => {
    const { engine, driver, journal } = setup();
    engine.report("report#1", { a: 1 });
    expect(journal.getNode(RUN, "report#1", 1)?.artifactId).toBeUndefined();
    expect(driver.eventsOfType("report")[0]?.artifactId).toBeUndefined();
  });

  it("标签指向未声明的 id 即 failRun，消息列出已声明的预置", async () => {
    const { engine } = setup();
    engine.declareArtifact("artifact#1", "chart", ["perf", CHART]);
    engine.report("report#1", { a: 1 }, "nope");
    const error = await failure(engine);
    expect(error.code).toBe("ArtifactUndeclared");
    expect(error.message).toContain("perf");
  });

  it("标签指向内容产物同样是 ArtifactUndeclared（它不是预置）", async () => {
    const { engine } = setup();
    await engine.publishArtifact("artifact#1", "markdown", ["doc", "hi"]);
    engine.report("report#1", { a: 1 }, "doc");
    expect((await failure(engine)).code).toBe("ArtifactUndeclared");
  });

  it("标签不进 inputHash：既有 journal 里的无标签 report 照旧命中", () => {
    const journal = new InMemoryJournalStore();
    const first = setup({ journal });
    first.engine.report("report#1", { a: 1 });
    first.engine.complete(undefined);

    const resumed = setup({ journal });
    resumed.engine.report("report#1", { a: 1 });
    expect(resumed.driver.eventsOfType("report")).toEqual([]);
    expect(resumed.engine.status()).toBe("running");
  });
});
