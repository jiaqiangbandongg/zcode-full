// 工作区 transcript 的读面（docs/dynamic-workflow/transcript-and-notifications.md）：
// 授权链（run 属于本会话）、清单的行映射、正文的保形有界化。
//
// 与 run service 的产物读面测试同一取向：负例逐条断言「什么都没放行」，而不是只看正例。
// 存储层用一个带 `listWorldNodes` 的内存 journal 替身——它的形状就是 adapters 的
// `DwfRunIntrospectionQueries.listWorldNodes`（那边的 SQL 在 adapters 的测试里钉）。
import { describe, expect, it } from "vitest";
import type { DwfWorldNodeRow } from "@zcode/adapters/storage";
import { InMemoryJournalStore } from "@zcode/dynamic-workflow";
import type { NodeRecord, RunRecord } from "@zcode/dynamic-workflow";
import {
  boundWorkspaceResult,
  listWorkspaceNodesFrom,
  readWorkspaceNodeResultFrom,
  supportsWorkspaceReads,
} from "../src/app/dynamic-workflow-run-workspace.js";

const PARENT = "ses_parent";
const RUN = "dwfrun-1";

/** 内存 journal + 一条 `listWorldNodes`：按 kind 过滤、按落库先后、不带正文、带库内摘要。 */
class WorkspaceJournal extends InMemoryJournalStore {
  private order = 0;
  private readonly seen = new Map<string, number>();

  override putNode(record: NodeRecord): void {
    const key = `${record.runId}/${record.siteId}@${record.ordinal}`;
    if (!this.seen.has(key)) this.seen.set(key, ++this.order);
    super.putNode(record);
  }

  listWorldNodes(runId: string): DwfWorldNodeRow[] {
    return this.listNodes(runId, { kinds: "all", withResult: true })
      .filter((node) => node.kind === "world-read" || node.kind === "world-run")
      .sort(
        (a, b) =>
          this.seen.get(`${a.runId}/${a.siteId}@${a.ordinal}`)! -
          this.seen.get(`${b.runId}/${b.siteId}@${b.ordinal}`)!,
      )
      .map((node) => {
        const { result, ...rest } = node;
        const serialized = result === undefined ? undefined : JSON.stringify(result);
        const summary =
          serialized === undefined
            ? {}
            : {
                resultBytes: Buffer.byteLength(serialized, "utf8"),
                ...(Array.isArray(result) ? { resultCount: result.length } : {}),
                ...(typeof result === "object" && result !== null && !Array.isArray(result)
                  ? {
                      exitCode: (result as { exitCode: number }).exitCode,
                      stdoutBytes: Buffer.byteLength((result as { stdout: string }).stdout),
                      stderrBytes: Buffer.byteLength((result as { stderr: string }).stderr),
                    }
                  : {}),
              };
        return { ...rest, timeCreated: 1_000, timeUpdated: 2_300, ...summary };
      });
  }
}

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: RUN,
    parentSessionId: PARENT,
    caps: { maxConcurrency: 4 },
    spentTokens: 0,
    status: "running",
    ...overrides,
  };
}

function seed(journal: WorkspaceJournal, runOverrides: Partial<RunRecord> = {}) {
  journal.createRun(run(runOverrides));
  journal.putNode({
    runId: RUN,
    siteId: "world-read#1",
    ordinal: 1,
    kind: "world-read",
    inputHash: "g",
    input: { op: "glob", args: ["src/**/*.ts"] },
    status: "completed",
    result: ["src/a.ts", "src/b.ts"],
  });
  journal.putNode({
    runId: RUN,
    siteId: "ask#1",
    ordinal: 1,
    kind: "ask",
    inputHash: "a",
    status: "completed",
    result: { text: "done" },
  });
  journal.putNode({
    runId: RUN,
    siteId: "world-read#2",
    ordinal: 1,
    kind: "world-run",
    inputHash: "r",
    input: { op: "run", args: ["pnpm", ["test"]] },
    status: "completed",
    result: { exitCode: 1, stdout: "1 failed\n", stderr: "boom" },
  });
  journal.putNode({
    runId: RUN,
    siteId: "world-read#2",
    ordinal: 2,
    kind: "world-run",
    inputHash: "r2",
    input: { op: "run", args: ["pnpm", ["test"]] },
    status: "failed",
    error: { code: "DriverError", message: "x".repeat(3_000) },
  });
  journal.putNode({
    runId: RUN,
    siteId: "world-read#3",
    ordinal: 1,
    kind: "world-read",
    inputHash: "old",
    status: "running",
  });
}

describe("dynamic workflow run workspace — 能力探测", () => {
  it("只认带 listWorldNodes 的 journal；纯引擎 journal 整个读面缺席", () => {
    expect(supportsWorkspaceReads(new InMemoryJournalStore())).toBe(false);
    expect(supportsWorkspaceReads(new WorkspaceJournal())).toBe(true);
  });

  it("不带读面的 journal：清单回 undefined（网关归一成空清单），正文也不放行", async () => {
    const journal = new InMemoryJournalStore();
    journal.createRun(run());
    expect(await listWorkspaceNodesFrom({ journal, parentSessionId: PARENT }, RUN)).toBeUndefined();
  });
});

describe("dynamic workflow run workspace — 清单", () => {
  it("只回 world 行、按落库先后、不带正文；op / args 来自 input，摘要来自库内计算", async () => {
    const journal = new WorkspaceJournal();
    seed(journal);
    const nodes = await listWorkspaceNodesFrom({ journal, parentSessionId: PARENT }, RUN);
    expect(nodes?.map((node) => `${node.siteId}@${node.ordinal}`)).toEqual([
      "world-read#1@1",
      "world-read#2@1",
      "world-read#2@2",
      "world-read#3@1",
    ]);
    expect(nodes?.[0]).toEqual({
      siteId: "world-read#1",
      ordinal: 1,
      kind: "world-read",
      op: "glob",
      args: ["src/**/*.ts"],
      status: "completed",
      summary: { resultBytes: JSON.stringify(["src/a.ts", "src/b.ts"]).length, resultCount: 2 },
      createdAt: 1_000,
      updatedAt: 2_300,
    });
    expect(nodes?.[1]).toMatchObject({
      kind: "world-run",
      op: "run",
      summary: { exitCode: 1, stdoutBytes: 9, stderrBytes: 4 },
    });
    for (const node of nodes ?? []) expect("result" in node).toBe(false);
  });

  it("失败行带切尾的 error、没有摘要；running 行两者都没有；历史行没有 op / args", async () => {
    const journal = new WorkspaceJournal();
    seed(journal);
    const nodes = (await listWorkspaceNodesFrom({ journal, parentSessionId: PARENT }, RUN))!;
    const failed = nodes[2]!;
    expect(failed.status).toBe("failed");
    expect(failed.error?.code).toBe("DriverError");
    expect(failed.error?.message.length).toBe(2_000);
    expect(failed.error?.message.endsWith("…")).toBe(true);
    expect("summary" in failed).toBe(false);
    const running = nodes[3]!;
    expect(running.status).toBe("running");
    expect("op" in running).toBe(false);
    expect("args" in running).toBe(false);
    expect("summary" in running).toBe(false);
  });

  it("截断过的 input 把 inputTruncated 透出", async () => {
    const journal = new WorkspaceJournal();
    journal.createRun(run());
    journal.putNode({
      runId: RUN,
      siteId: "world-read#1",
      ordinal: 1,
      kind: "world-run",
      inputHash: "t",
      input: { op: "run", args: ["node", '["-e","…'], truncated: true },
      status: "running",
    });
    const nodes = await listWorkspaceNodesFrom({ journal, parentSessionId: PARENT }, RUN);
    expect(nodes?.[0]).toMatchObject({ op: "run", inputTruncated: true });
  });

  it("授权负例：不是本会话的 run、parentSessionId 为 NULL 的老行、未知 run 都回 undefined，三者不可区分", async () => {
    const other = new WorkspaceJournal();
    seed(other, { parentSessionId: "ses_other" });
    expect(
      await listWorkspaceNodesFrom({ journal: other, parentSessionId: PARENT }, RUN),
    ).toBeUndefined();

    const legacy = new WorkspaceJournal();
    seed(legacy, { parentSessionId: undefined });
    expect(
      await listWorkspaceNodesFrom({ journal: legacy, parentSessionId: PARENT }, RUN),
    ).toBeUndefined();

    const mine = new WorkspaceJournal();
    seed(mine);
    expect(
      await listWorkspaceNodesFrom({ journal: mine, parentSessionId: PARENT }, "dwfrun-nope"),
    ).toBeUndefined();
  });
});

describe("dynamic workflow run workspace — 正文", () => {
  const deps = () => {
    const journal = new WorkspaceJournal();
    seed(journal);
    return { journal, parentSessionId: PARENT };
  };

  it("completed 行回正文；failed 行只有 error；running 行两者都没有", async () => {
    const d = deps();
    expect(
      await readWorkspaceNodeResultFrom(d, RUN, "world-read#2", 1, { maxBytes: 32_768 }),
    ).toEqual({
      status: "completed",
      result: { exitCode: 1, stdout: "1 failed\n", stderr: "boom" },
      truncated: false,
      totalBytes: JSON.stringify({ exitCode: 1, stdout: "1 failed\n", stderr: "boom" }).length,
    });
    const failed = await readWorkspaceNodeResultFrom(d, RUN, "world-read#2", 2, {
      maxBytes: 32_768,
    });
    expect(failed).toMatchObject({ status: "failed", truncated: false, totalBytes: 0 });
    expect(failed?.error?.code).toBe("DriverError");
    expect("result" in failed!).toBe(false);
    expect(
      await readWorkspaceNodeResultFrom(d, RUN, "world-read#3", 1, { maxBytes: 32_768 }),
    ).toEqual({
      status: "running",
      truncated: false,
      totalBytes: 0,
    });
  });

  it("授权负例：ask 行、未知节点、不是本会话的 run 都回 undefined", async () => {
    const d = deps();
    expect(
      await readWorkspaceNodeResultFrom(d, RUN, "ask#1", 1, { maxBytes: 32_768 }),
    ).toBeUndefined();
    expect(
      await readWorkspaceNodeResultFrom(d, RUN, "world-read#9", 1, { maxBytes: 32_768 }),
    ).toBeUndefined();
    expect(
      await readWorkspaceNodeResultFrom(
        { ...d, parentSessionId: "ses_other" },
        RUN,
        "world-read#2",
        1,
        {
          maxBytes: 32_768,
        },
      ),
    ).toBeUndefined();
  });
});

describe("boundWorkspaceResult — 保形有界化", () => {
  it("不超限原样回，truncated=false", () => {
    expect(boundWorkspaceResult(["a", "b"], 1024)).toEqual({
      result: ["a", "b"],
      truncated: false,
      totalBytes: 9,
    });
  });

  it("字符串切尾到 ≤ maxBytes 个 UTF-8 字节，不切在多字节字符中间", () => {
    const text = "é".repeat(100); // 每个 2 字节
    const bounded = boundWorkspaceResult(text, 51);
    expect(bounded.truncated).toBe(true);
    expect(bounded.totalBytes).toBe(202);
    expect(typeof bounded.result).toBe("string");
    expect(Buffer.byteLength(bounded.result as string, "utf8")).toBeLessThanOrEqual(51);
    expect(bounded.result).toBe("é".repeat(25));
  });

  it("数组逐项累加、放不下的去尾", () => {
    const items = Array.from({ length: 50 }, (_, i) => `src/file-${i}.ts`);
    const bounded = boundWorkspaceResult(items, 200);
    expect(bounded.truncated).toBe(true);
    expect(Array.isArray(bounded.result)).toBe(true);
    const kept = bounded.result as string[];
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(50);
    expect(kept).toEqual(items.slice(0, kept.length));
    expect(Buffer.byteLength(JSON.stringify(kept), "utf8")).toBeLessThanOrEqual(200);
  });

  it("world.run 的正文：exitCode 恒保留，stdout / stderr 各分预算，一路用不完的让给另一路", () => {
    const result = { exitCode: 2, stdout: "o".repeat(10_000), stderr: "e".repeat(10) };
    const bounded = boundWorkspaceResult(result, 1_024);
    expect(bounded.truncated).toBe(true);
    const value = bounded.result as { exitCode: number; stdout: string; stderr: string };
    expect(value.exitCode).toBe(2);
    expect(value.stderr).toBe("e".repeat(10));
    expect(value.stdout.length).toBeGreaterThan(900);
    expect(Buffer.byteLength(JSON.stringify(value), "utf8")).toBeLessThanOrEqual(1_024);
  });

  it("其它形状超限时退化成切尾的 JSON 文本", () => {
    const bounded = boundWorkspaceResult({ big: "x".repeat(5_000) }, 100);
    expect(bounded.truncated).toBe(true);
    expect(typeof bounded.result).toBe("string");
    expect((bounded.result as string).startsWith('{"big":"xxx')).toBe(true);
  });
});
