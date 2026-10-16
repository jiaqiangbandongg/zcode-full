// 用户面产物在观察面的合成规则（docs/dynamic-workflow/authoring.md）：
// `artifactsOf` 与终态快照上的 `artifacts` 键。
//
// ⚠ 术语：本文件里的 artifact 是脚本经 `artifact.*` **发布给用户看的产出**（journal
// `kind = "artifact"` 的行），不是 `RunSettlement.artifact`（脚本顶层返回值，快照上叫
// `output`）。同一个词两个义，spec 的「术语」表是唯一消歧处——两者在本文件的断言里并列出现。
//
// 端口的两条查询（`listArtifactRows` / `listArtifactItems`）不在引擎的 JournalStorePort 上，
// 所以生产路径靠能力探测接上；这里用一个带 / 不带那个方法的内存 journal 把两支都跑到。
import { describe, expect, it, vi } from "vitest";
import { InMemoryJournalStore, type NodeRecord, type RunStatus } from "@zcode/dynamic-workflow";
import {
  artifactsOf,
  snapshotOf,
  type RunRegistryEntry,
} from "../src/app/dynamic-workflow-run-observation.js";

/** 带 `listArtifactRows` 的 journal：adapters 侧那条宿主查询的内存替身。 */
class ArtifactAwareJournalStore extends InMemoryJournalStore {
  listArtifactRows(runId: string): NodeRecord[] {
    // 真实现按 id 升序（插入序 = 版本序）取 `kind = 'artifact'` 的行；内存实现的 listNodes
    // 已经是插入序，所以过滤即可。
    return this.listNodes(runId, { kinds: ["artifact"], withResult: true });
  }
}

function makeRun(journal: InMemoryJournalStore, runId: string, status: RunStatus): void {
  journal.createRun({ runId, caps: { maxConcurrency: 4 }, spentTokens: 0, status });
}

function putArtifact(
  journal: InMemoryJournalStore,
  runId: string,
  ordinal: number,
  record: Record<string, unknown>,
  overrides: { status?: "completed" | "failed"; artifactId?: string } = {},
): void {
  journal.putNode({
    runId,
    siteId: `artifact#${ordinal}`,
    ordinal,
    kind: "artifact",
    inputHash: `hash-${ordinal}`,
    status: overrides.status ?? "completed",
    artifactId: overrides.artifactId ?? (record.id as string),
    ...(overrides.status === "failed"
      ? { error: { code: "ArtifactSourceMissing", message: "gone" } }
      : { result: record }),
  });
}

function putTaggedReport(
  journal: InMemoryJournalStore,
  runId: string,
  ordinal: number,
  artifactId?: string,
): void {
  journal.putNode({
    runId,
    siteId: "report#1",
    ordinal,
    kind: "report",
    inputHash: `report-${ordinal}`,
    status: "completed",
    ...(artifactId === undefined ? {} : { artifactId }),
    result: { round: ordinal },
  });
}

describe("artifactsOf — journal 行 → 端口的 artifacts", () => {
  it("能力缺席（journal 不带 listArtifactRows）⇒ 整字段缺席，绝不抛", () => {
    const journal = new InMemoryJournalStore();
    makeRun(journal, "run-plain", "completed");
    expect(artifactsOf("run-plain", journal)).toEqual({});
  });

  it("零行 / 未知 run ⇒ 整字段缺席（空数组读起来像「跑过但没产出」）", () => {
    const journal = new ArtifactAwareJournalStore();
    makeRun(journal, "run-empty", "completed");
    expect(artifactsOf("run-empty", journal)).toEqual({});
    expect(artifactsOf("run-unknown", journal)).toEqual({});
  });

  it("同 id 的多行归成一件、版本升序，顶层字段取最新版", () => {
    const journal = new ArtifactAwareJournalStore();
    makeRun(journal, "run-versions", "completed");
    putArtifact(journal, "run-versions", 1, {
      id: "audit",
      kind: "file",
      version: 1,
      title: "旧版",
      contentType: "text/plain",
      sourcePath: "out/audit.txt",
      bytes: 10,
      uri: "zcode-artifact://one",
      publishedAt: 1,
    });
    putArtifact(journal, "run-versions", 2, {
      id: "audit",
      kind: "file",
      version: 2,
      title: "审计报告",
      contentType: "application/pdf",
      sourcePath: "out/audit.pdf",
      bytes: 4_096,
      uri: "zcode-artifact://two",
      publishedAt: 2,
    });

    const { artifacts } = artifactsOf("run-versions", journal);
    expect(artifacts).toHaveLength(1);
    const audit = artifacts![0]!;
    expect(audit.id).toBe("audit");
    expect(audit.version).toBe(2);
    expect(audit.title).toBe("审计报告");
    expect(audit.contentType).toBe("application/pdf");
    expect(audit.sourcePath).toBe("out/audit.pdf");
    // 版本历史完整保留、升序；字节与 uri 只挂在版本项上。
    expect(audit.versions.map((version) => version.version)).toEqual([1, 2]);
    expect(audit.versions[1]?.bytes).toBe(4_096);
    expect(audit.versions[0]?.uri).toBe("zcode-artifact://one");
    // 内容产物恒 0 条。
    expect(audit.itemCount).toBe(0);
  });

  // 交付物（docs/dynamic-workflow/authoring.md「Ids, tags and versions」）：旗子在版本记录上由引擎盖章、
  // 按 id 粘着；投影把它抬到顶层，并让它带头——顺序在这里定一次，下游的每个上界都砍不到它。
  it("primary 从版本记录抬到顶层，且交付物带头、其余保持首次发布顺序", () => {
    const journal = new ArtifactAwareJournalStore();
    makeRun(journal, "run-primary", "completed");
    putArtifact(journal, "run-primary", 1, { id: "perf", kind: "chart", version: 1, publishedAt: 1 });
    putArtifact(journal, "run-primary", 2, { id: "notes-a", kind: "markdown", version: 1, publishedAt: 2 });
    putArtifact(journal, "run-primary", 3, { id: "notes-b", kind: "markdown", version: 1, publishedAt: 3 });
    putArtifact(journal, "run-primary", 4, {
      id: "report",
      kind: "markdown",
      version: 1,
      title: "审计报告",
      description: "结论与修复建议",
      primary: true,
      publishedAt: 4,
    });
    putArtifact(journal, "run-primary", 5, {
      id: "report",
      kind: "markdown",
      version: 2,
      title: "审计报告",
      primary: true,
      publishedAt: 5,
    });

    const { artifacts } = artifactsOf("run-primary", journal);
    expect(artifacts!.map((artifact) => artifact.id)).toEqual(["report", "perf", "notes-a", "notes-b"]);
    const report = artifacts![0]!;
    expect(report.primary).toBe(true);
    expect(report.versions.map((version) => version.primary)).toEqual([true, true]);
    // 非交付物的键缺席，不是 false。
    for (const other of artifacts!.slice(1)) expect("primary" in other).toBe(false);
    for (const version of artifacts![1]!.versions) expect("primary" in version).toBe(false);
  });

  it("没有交付物时顺序与形状与旧 CLI 落的行完全一致（旗子从不被推断）", () => {
    const journal = new ArtifactAwareJournalStore();
    makeRun(journal, "run-no-primary", "completed");
    putArtifact(journal, "run-no-primary", 1, { id: "b", kind: "markdown", version: 1, publishedAt: 1 });
    putArtifact(journal, "run-no-primary", 2, { id: "a", kind: "markdown", version: 1, publishedAt: 2 });
    const { artifacts } = artifactsOf("run-no-primary", journal);
    expect(artifacts!.map((artifact) => artifact.id)).toEqual(["b", "a"]);
    expect(artifacts!.some((artifact) => "primary" in artifact)).toBe(false);
  });

  it("失败的发布行不进版本历史（它不占 id、不占版本号）", () => {
    const journal = new ArtifactAwareJournalStore();
    makeRun(journal, "run-failed", "completed");
    putArtifact(journal, "run-failed", 1, {
      id: "audit",
      kind: "file",
      version: 1,
      publishedAt: 1,
    });
    putArtifact(
      journal,
      "run-failed",
      2,
      { id: "audit" },
      { status: "failed", artifactId: "audit" },
    );

    const { artifacts } = artifactsOf("run-failed", journal);
    expect(artifacts).toHaveLength(1);
    expect(artifacts![0]!.versions).toHaveLength(1);
    expect(artifacts![0]!.version).toBe(1);
  });

  it("itemCount 只数带该 id 标签的 report 行；无标签的与别的 id 都不算", () => {
    const journal = new ArtifactAwareJournalStore();
    makeRun(journal, "run-items", "completed");
    putArtifact(journal, "run-items", 1, {
      id: "perf",
      kind: "chart",
      version: 1,
      publishedAt: 1,
      spec: { x: { field: "round" }, y: { field: "ms" } },
    });
    putArtifact(journal, "run-items", 2, {
      id: "board",
      kind: "board",
      version: 1,
      publishedAt: 2,
      spec: { key: "id", status: "state", columns: ["todo"] },
    });
    putTaggedReport(journal, "run-items", 1, "perf");
    putTaggedReport(journal, "run-items", 2, "perf");
    putTaggedReport(journal, "run-items", 3, "board");
    putTaggedReport(journal, "run-items", 4);

    const { artifacts } = artifactsOf("run-items", journal);
    expect(artifacts?.map((artifact) => [artifact.id, artifact.itemCount])).toEqual([
      ["perf", 2],
      ["board", 1],
    ]);
    // 预置看板的 spec 原样带出（UI 据它渲染）。
    expect(artifacts![0]!.spec).toEqual({ x: { field: "round" }, y: { field: "ms" } });
  });

  /**
   * 中枢一页 50 行、每行调一次本函数：内容产物的 `itemCount` 恒 0，为它扫一遍全表是纯浪费。
   * 这条断言是那条路径上唯一的挡板。
   */
  it("只有内容产物时不扫节点表；有预置看板时才扫一次", () => {
    const journal = new ArtifactAwareJournalStore();
    makeRun(journal, "run-content", "completed");
    putArtifact(journal, "run-content", 1, {
      id: "notes",
      kind: "markdown",
      version: 1,
      publishedAt: 1,
    });
    const contentSpy = vi.spyOn(journal, "listNodes");
    contentSpy.mockClear();
    artifactsOf("run-content", journal);
    // listArtifactRows 自己会调一次 listNodes（内存替身的实现细节），所以判据是「没有为了
    // 计数再调一次」：一次来自行查询，第二次才是计数。
    expect(contentSpy).toHaveBeenCalledTimes(1);

    makeRun(journal, "run-preset", "completed");
    putArtifact(journal, "run-preset", 1, {
      id: "perf",
      kind: "chart",
      version: 1,
      publishedAt: 1,
      spec: {},
    });
    contentSpy.mockClear();
    artifactsOf("run-preset", journal);
    expect(contentSpy).toHaveBeenCalledTimes(2);
  });

  it("形状不合的行整条跳过：非对象 result、缺 version、未知 kind", () => {
    const journal = new ArtifactAwareJournalStore();
    makeRun(journal, "run-bad", "completed");
    journal.putNode({
      runId: "run-bad",
      siteId: "artifact#1",
      ordinal: 1,
      kind: "artifact",
      inputHash: "h1",
      status: "completed",
      artifactId: "a",
      result: "not an object",
    });
    putArtifact(journal, "run-bad", 2, { id: "b", kind: "file", publishedAt: 1 });
    putArtifact(journal, "run-bad", 3, { id: "c", kind: "hologram", version: 1, publishedAt: 1 });
    putArtifact(journal, "run-bad", 4, { id: "d", kind: "file", version: 1, publishedAt: 1 });

    const { artifacts } = artifactsOf("run-bad", journal);
    expect(artifacts?.map((artifact) => artifact.id)).toEqual(["d"]);
  });

  // driver 恒写 publishedAt（引擎的类型上它才是可选的）。缺席时给 0 而不是丢行：一个没有
  // 时间戳的产物仍然可看，丢掉它会让版本号在 UI 上出现空洞。
  it("缺 publishedAt 的老行仍然可读，时间戳落到 0", () => {
    const journal = new ArtifactAwareJournalStore();
    makeRun(journal, "run-old", "completed");
    putArtifact(journal, "run-old", 1, { id: "legacy", kind: "markdown", version: 1 });
    const { artifacts } = artifactsOf("run-old", journal);
    expect(artifacts![0]!.versions[0]?.publishedAt).toBe(0);
  });
});

describe("snapshotOf — 终态快照上的 artifacts", () => {
  function entryFor(): Map<string, RunRegistryEntry> {
    return new Map();
  }

  it("终态才带 artifacts；running 的快照一行都不读", () => {
    const journal = new ArtifactAwareJournalStore();
    makeRun(journal, "run-live", "running");
    putArtifact(journal, "run-live", 1, {
      id: "notes",
      kind: "markdown",
      version: 1,
      publishedAt: 1,
    });
    const listNodes = vi.spyOn(journal, "listNodes");

    const running = snapshotOf("run-live", entryFor(), journal);
    expect(running?.status).toBe("running");
    expect(running && "artifacts" in running).toBe(false);
    expect(running && "reports" in running).toBe(false);
    // 在飞时既不扫节点表也不查产物行：`getTask` 会被后台追踪器反复轮询。
    expect(listNodes).not.toHaveBeenCalled();

    journal.updateRunStatus("run-live", "completed", { result: "done" });
    const settled = snapshotOf("run-live", entryFor(), journal);
    expect(settled?.artifacts).toHaveLength(1);
    expect(settled?.artifacts?.[0]?.id).toBe("notes");
    // ⚠ 两个 artifact 并列：`output` 是脚本的顶层返回值，`artifacts` 是发布给用户看的产出。
    expect(settled?.output).toBe("done");
  });

  it("errored 与 stopped 的快照一样带 artifacts（半途交付的东西仍在用户面前）", () => {
    // 快照基类的 status 是后台任务追踪器的通用词汇（errored → failed、stopped → cancelled）；
    // 真实词在 runStatus 上（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md）。
    for (const [status, taskStatus] of [
      ["errored", "failed"],
      ["stopped", "cancelled"],
    ] as const) {
      const journal = new ArtifactAwareJournalStore();
      const runId = `run-${status}`;
      makeRun(journal, runId, "running");
      putArtifact(journal, runId, 1, { id: "notes", kind: "markdown", version: 1, publishedAt: 1 });
      journal.updateRunStatus(runId, status, {
        ...(status === "stopped" ? { stopReason: "interrupted" as const } : {}),
        failure: { code: status === "stopped" ? "Interrupted" : "DriverError", message: "boom" },
      });

      const snapshot = snapshotOf(runId, entryFor(), journal);
      expect(snapshot?.status).toBe(taskStatus);
      expect(snapshot?.runStatus).toBe(status);
      expect(snapshot?.artifacts).toHaveLength(1);
    }
  });

  it("零件时整字段缺席；journal 不带能力时也缺席", () => {
    const journal = new ArtifactAwareJournalStore();
    makeRun(journal, "run-none", "completed");
    const snapshot = snapshotOf("run-none", entryFor(), journal);
    expect(snapshot && "artifacts" in snapshot).toBe(false);

    const plain = new InMemoryJournalStore();
    makeRun(plain, "run-plain", "completed");
    putArtifact(plain, "run-plain", 1, {
      id: "notes",
      kind: "markdown",
      version: 1,
      publishedAt: 1,
    });
    const plainSnapshot = snapshotOf("run-plain", entryFor(), plain);
    expect(plainSnapshot && "artifacts" in plainSnapshot).toBe(false);
  });

  // 终态快照的读形状（docs/execution-engine.md「Reading the journal」）：report item 只读到
  // 快照的界，总数是 count，标签计数只读元数据——没有一次读把整张节点表连同 item 读出来。
  it("reads report items only up to the snapshot bound and counts everything else", () => {
    const journal = new ArtifactAwareJournalStore();
    makeRun(journal, "run-share", "running");
    putArtifact(journal, "run-share", 1, {
      id: "perf",
      kind: "chart",
      version: 1,
      publishedAt: 1,
      spec: {},
    });
    putTaggedReport(journal, "run-share", 1, "perf");
    putTaggedReport(journal, "run-share", 2);
    journal.updateRunStatus("run-share", "completed");
    const listNodes = vi.spyOn(journal, "listNodes");

    const snapshot = snapshotOf("run-share", entryFor(), journal);
    expect(snapshot?.reports).toHaveLength(2);
    expect(snapshot?.reportCount).toBe(2);
    expect(snapshot?.artifacts?.[0]?.itemCount).toBe(1);
    expect(listNodes.mock.calls.map(([, opts]) => opts)).toEqual([
      { kinds: ["report"], withResult: true, limit: 256, maxResultBytes: 8 * 1024 * 1024 },
      // listArtifactRows 的内存替身
      { kinds: ["artifact"], withResult: true },
      // 不带 countTaggedReports 的 store 退回读 report 元数据（不带 item）
      { kinds: ["report"], withResult: false },
    ]);
  });

  it("carries the first 256 items and the true total when a run reported more", () => {
    const journal = new ArtifactAwareJournalStore();
    makeRun(journal, "run-many", "running");
    for (let ordinal = 1; ordinal <= 300; ordinal += 1)
      putTaggedReport(journal, "run-many", ordinal);
    journal.updateRunStatus("run-many", "completed");

    const snapshot = snapshotOf("run-many", entryFor(), journal);
    expect(snapshot?.reportCount).toBe(300);
    expect(snapshot?.reports).toHaveLength(256);
    // 报告顺序：前 256 条，一条不跳。
    expect(snapshot?.reports?.[0]).toEqual({ round: 1 });
    expect(snapshot?.reports?.[255]).toEqual({ round: 256 });
  });

  it("leaves reports and reportCount out when the run reported nothing", () => {
    const journal = new ArtifactAwareJournalStore();
    makeRun(journal, "run-quiet", "completed");
    const snapshot = snapshotOf("run-quiet", entryFor(), journal);
    expect(snapshot && "reports" in snapshot).toBe(false);
    expect(snapshot && "reportCount" in snapshot).toBe(false);
  });
});
