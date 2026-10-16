/**
 * 修复原因：journal-contract.ts 顶到 oxlint max-lines 上限（400 行），把用户面产物行（kind: "artifact"、artifactId 列、report 标签）的用例拆到本文件；
 * 公开面仍从 journal-contract.ts 导出（`runJournalStoreContract` 按原顺序调用各主题的注册函数）。
 *
 * 注意：这里只登记 `it(...)`，不另开 describe——套件的分组与用例顺序必须与拆分前逐字相同。
 */

import { expect, it } from "vitest";
import type { ArtifactVersionRecord, JournalStorePort, NodeRecord } from "../engine/index.js";
import { baseRun } from "./journal-contract-helpers.js";

export function registerArtifactCases(factory: () => JournalStorePort): void {
  // ——— 用户面产物（docs/dynamic-workflow/authoring.md）———
  // ⚠ 这里的 artifact 是脚本发布给用户看的交付物，不是 `RunSettlement.artifact`
  // （脚本顶层返回值）。两义并存，见 spec 的「术语」表。

  // 内容成员成功发布的落库形状：`kind: "artifact"`、`result` 即整条 ArtifactVersionRecord、
  // `artifactId` 指向它发布的那个产物。两个实现都必须**逐字**回读——`uri` 是字节的唯一
  // 去路（字节不进 journal），加工或丢弃它就等于把一个已发布的产物变成打不开的卡片。
  it("round-trips a completed artifact node with its version record", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    const record: ArtifactVersionRecord = {
      id: "book",
      kind: "file",
      version: 2,
      title: "注意力之书",
      description: "59 页 typst 排版",
      contentType: "application/pdf",
      bytes: 1_234_567,
      uri: "zcode-artifact://ses_parent/abc123",
      sourcePath: "out/book.pdf",
      publishedAt: 1_725_000_000_000,
      primary: true,
    };
    const node: NodeRecord = {
      runId: "r1",
      siteId: "artifact#1",
      ordinal: 2,
      kind: "artifact",
      inputHash: "ah",
      status: "completed",
      result: record,
      artifactId: "book",
    };
    store.putNode(node);

    const stored = store.getNode("r1", "artifact#1", 2);
    expect(stored).toEqual(node);
    expect(stored?.result).toEqual(record);
  });

  // 预置声明的行：同一个 kind、同一列 artifactId，只是 result 里装的是 spec 而不是字节元数据。
  // 看板本身不含数据（它的每个点是一行标签 report），所以这一行就是「这个看板存在过」的全部记录。
  it("round-trips a preset declaration artifact node with its spec", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    const record: ArtifactVersionRecord = {
      id: "perf",
      kind: "chart",
      version: 1,
      title: "查询延迟",
      spec: { type: "line", x: { field: "round" }, y: [{ field: "queryMsAfter" }] },
    };
    const node: NodeRecord = {
      runId: "r1",
      siteId: "artifact#2",
      ordinal: 1,
      kind: "artifact",
      inputHash: "ph",
      status: "completed",
      result: record,
      artifactId: "perf",
    };
    store.putNode(node);
    expect(store.getNode("r1", "artifact#2", 1)).toEqual(node);
  });

  // 失败的发布必须**带着 artifactId 落库**：读面要能说出「这个 id 的这次发布没成功」。
  // 失败行没有 result（字节从未写成），错误在 error 上——这与 settled failure 必须落库
  // 是同一条重放健全性要求。
  it("round-trips a failed artifact node with its error and artifact id", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    const failed: NodeRecord = {
      runId: "r1",
      siteId: "artifact#1",
      ordinal: 3,
      kind: "artifact",
      inputHash: "ah3",
      status: "failed",
      error: { code: "ArtifactSourceMissing", message: "out/book.pdf 不存在" },
      artifactId: "book",
    };
    store.putNode(failed);

    const stored = store.getNode("r1", "artifact#1", 3);
    expect(stored).toEqual(failed);
    expect(stored !== undefined && "result" in stored).toBe(false);
  });

  // 内容成员走的是「准入 running → 结算」两次写，而 putNode 是整条替换的 upsert：
  // 结算那一次若不再带上 artifactId，产物归属会被抹掉，那次发布就从「本 run 有哪些产物」
  // 的读面上消失。引擎两次写都带着它，这条把该形状钉在存储层。
  it("keeps the artifact id across the running → settled rewrite", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    const running: NodeRecord = {
      runId: "r1",
      siteId: "artifact#1",
      ordinal: 1,
      kind: "artifact",
      inputHash: "ah",
      status: "running",
      artifactId: "book",
    };
    store.putNode(running);
    expect(store.getNode("r1", "artifact#1", 1)).toEqual(running);

    store.putNode({
      ...running,
      status: "completed",
      result: { id: "book", kind: "file", version: 1 } satisfies ArtifactVersionRecord,
    });
    const settled = store.getNode("r1", "artifact#1", 1)!;
    expect(settled.status).toBe("completed");
    expect(settled.artifactId).toBe("book");
  });

  // 「看板是 journal 的投影」这条不变式的落点：一个看板的每个点都是一行
  // `kind = "report"` ∧ `artifactId` 相符。标签因此必须与 item 同寿地落在 report 行上。
  it("round-trips the artifact tag on a report node", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    const tagged: NodeRecord = {
      runId: "r1",
      siteId: "report#1",
      ordinal: 3,
      kind: "report",
      inputHash: "rh",
      status: "completed",
      result: { round: 3, queryMsAfter: 12.5 },
      artifactId: "perf",
    };
    store.putNode(tagged);
    expect(store.getNode("r1", "report#1", 3)).toEqual(tagged);
  });

  // 未打标签的 report、ask、world-* 与 0029 之前的历史行都没有这一列：必须解成**缺席的键**
  // 而不是一个值为 undefined 的键。看板取数按「artifactId 相符」筛行，多出来的键会让
  // 整条 toEqual 失败，也会让「没有标签」与「标签是 undefined」在读面上不可分辨。
  it("leaves artifactId absent on nodes that carry no artifact", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    const plain: NodeRecord = {
      runId: "r1",
      siteId: "report#2",
      ordinal: 1,
      kind: "report",
      inputHash: "rh2",
      status: "completed",
      result: { finding: "untagged" },
    };
    store.putNode(plain);

    const stored = store.getNode("r1", "report#2", 1)!;
    expect("artifactId" in stored).toBe(false);
    expect(stored).toEqual(plain);
  });

  // listNodes 是引擎恢复产物版本号的取数面（「该 id 已 completed 的行数 + 1」，同
  // reportCount 的恢复法），所以标签必须在枚举读面上也在场——只在 getNode 上回读是不够的。
  it("returns artifactId from listNodes as well as getNode", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    store.putNode({
      runId: "r1",
      siteId: "artifact#1",
      ordinal: 1,
      kind: "artifact",
      inputHash: "a1",
      status: "completed",
      result: { id: "book", kind: "file", version: 1 } satisfies ArtifactVersionRecord,
      artifactId: "book",
    });
    store.putNode({
      runId: "r1",
      siteId: "report#1",
      ordinal: 1,
      kind: "report",
      inputHash: "r1h",
      status: "completed",
      result: { round: 1 },
      artifactId: "perf",
    });
    store.putNode({
      runId: "r1",
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      inputHash: "k1",
      status: "completed",
      result: "plain",
    });

    const nodes = store.listNodes("r1", { kinds: "all", withResult: true });
    expect(nodes.map((n) => n.artifactId)).toEqual(["book", "perf", undefined]);
    expect("artifactId" in nodes[2]!).toBe(false);
  });
}
