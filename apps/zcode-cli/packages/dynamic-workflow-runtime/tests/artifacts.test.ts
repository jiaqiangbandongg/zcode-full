/**
 * 用户面产物（docs/dynamic-workflow/authoring.md）穿过整条管线：真实脚本 → lowering → 沙箱
 * 子进程 → NDJSON 线协议 → 引擎核心 → driver。本文件钉的是**线协议那一段**：两族成员各
 * 走哪条通道、标签能不能过界、拒绝能不能被脚本 catch。
 *
 * ⚠ 术语：这里的 artifact 是用户面产物；`settlement.artifact` 是脚本的顶层返回值——同一个
 * 词的两个意思在一个文件里同时出现，正是 spec 的「术语」表存在的理由。
 */

import { describe, expect, it } from "vitest";
import { WorkflowError, type ArtifactVersionRecord } from "@zcode/dynamic-workflow";
import { runScript } from "./helpers.js";

const RUN = "run";
const CHART = '{ x: { field: "round" }, y: { field: "ms" } }';

describe("e2e — 预置产物与打标签的 report", () => {
  it("声明经事件通道先行到达，随后每条标签 report 都落到那个 id 上", async () => {
    const script = [
      `artifact.chart("perf", ${CHART});`,
      "for (const round of [1, 2, 3]) {",
      "  report({ round, ms: round * 10 }, \"perf\");",
      "}",
      "return { rounds: 3 };",
    ].join("\n");

    const { settlement, journal, driver } = await runScript(script);
    expect(settlement.status).toBe("completed");

    // 声明落一行 artifact 节点，带 artifact_id 与 spec。
    const declaration = journal.getNode(RUN, "artifact#1", 1);
    expect(declaration?.kind).toBe("artifact");
    expect(declaration?.artifactId).toBe("perf");
    expect((declaration?.result as ArtifactVersionRecord | undefined)?.kind).toBe("chart");

    // 三条 report 行都带同一个 artifact_id——「看板 = journal 的投影」的落点。
    const reports = journal
      .listNodes(RUN, { kinds: "all", withResult: true })
      .filter((node) => node.kind === "report");
    expect(reports.map((node) => node.artifactId)).toEqual(["perf", "perf", "perf"]);
    expect(driver.eventsOfType("report").map((event) => event.artifactId)).toEqual([
      "perf",
      "perf",
      "perf",
    ]);

    // 事件顺序：artifact-published 必须早于第一条 report（同一条 FIFO 事件通道）。
    const types = driver.events.map((event) => event.type);
    expect(types.indexOf("artifact-published")).toBeLessThan(types.indexOf("report"));
  });

  it("同一份 spec 重复声明是幂等 no-op，run 照常完成", async () => {
    const script = [
      `artifact.chart("perf", ${CHART});`,
      `artifact.chart("perf", ${CHART});`,
      "return 1;",
    ].join("\n");
    const { settlement, driver, journal } = await runScript(script);
    expect(settlement.status).toBe("completed");
    expect(driver.eventsOfType("artifact-published")).toHaveLength(1);
    expect(
      journal
        .listNodes(RUN, { kinds: "all", withResult: true })
        .filter((node) => node.kind === "artifact"),
    ).toHaveLength(1);
  });

  it("标签指向未声明的 id 让整个 run 失败（void 返回没有拒绝通道）", async () => {
    const { settlement } = await runScript(`report({ a: 1 }, "perf");\nreturn 1;`);
    expect(settlement.status).toBe("errored");
    if (settlement.status !== "errored") return;
    expect(settlement.error.code).toBe("ArtifactUndeclared");
  });
});

describe("e2e — 内容产物", () => {
  it("经 request/response 过界，实参按位置透传，ref 回到脚本", async () => {
    const script = [
      'const ref = await artifact.file("book", "out/book.pdf", { title: "Book" });',
      'const notes = await artifact.markdown("notes", "# hi");',
      "return { id: ref.id, version: ref.version, notes: notes.id };",
    ].join("\n");

    const { settlement, driver, journal } = await runScript(script);
    expect(settlement).toEqual({
      status: "completed",
      artifact: { id: "book", version: 1, notes: "notes" },
    });

    expect(driver.artifactPublishes.map((r) => [r.op, r.id, r.version, r.path, r.content])).toEqual([
      ["file", "book", 1, "out/book.pdf", undefined],
      ["markdown", "notes", 1, undefined, "# hi"],
    ]);
    expect(driver.artifactPublishes[0]?.opts).toEqual({ title: "Book" });
    expect(journal.getNode(RUN, "artifact#1", 1)?.status).toBe("completed");
    expect(driver.eventsOfType("artifact-published").map((e) => e.artifact.id)).toEqual([
      "book",
      "notes",
    ]);
  });

  it("同 id 再发布是新版本", async () => {
    const script = [
      'const a = await artifact.markdown("notes", "one");',
      'const b = await artifact.markdown("notes", "two");',
      "return [a.version, b.version];",
    ].join("\n");
    const { settlement } = await runScript(script);
    expect(settlement).toEqual({ status: "completed", artifact: [1, 2] });
  });

  it("driver 的拒绝以结构化错误过界，脚本能 catch 并继续", async () => {
    const script = [
      "let code = \"none\";",
      "try {",
      '  await artifact.file("book", "out/missing.pdf");',
      "} catch (e) {",
      "  code = (e as { code?: string }).code ?? \"no-code\";",
      "}",
      "return code;",
    ].join("\n");

    const { settlement, journal, driver } = await runScript(script, {
      artifacts: () => {
        throw new WorkflowError("ArtifactSourceMissing", "out/missing.pdf 不存在");
      },
    });
    // 门控习语跑通：脚本拿到结构化 code，run 正常完成。
    expect(settlement).toEqual({ status: "completed", artifact: "ArtifactSourceMissing" });
    expect(journal.getNode(RUN, "artifact#1", 1)?.status).toBe("failed");
    expect(journal.getNode(RUN, "artifact#1", 1)?.error?.code).toBe("ArtifactSourceMissing");
    // 失败走 artifact-failed，不冒充一个节点结算（产物站点在图里没有节点）。
    expect(driver.eventsOfType("artifact-failed").map((e) => [e.id, e.op, e.error.code])).toEqual([
      ["book", "file", "ArtifactSourceMissing"],
    ]);
    expect(driver.eventsOfType("node-settled")).toEqual([]);
  });

  it("与 ask 混跑：子代理写出的路径由脚本交出去", async () => {
    const script = [
      'const writer = agent("writer");',
      'const path = await writer.ask("write the book");',
      'const ref = await artifact.file("book", path, { title: "Book" });',
      "return ref.version;",
    ].join("\n");

    const { settlement, driver } = await runScript(script, {
      asks: { "ask#1": () => ({ type: "text", finalText: "out/book.pdf" }) },
    });
    expect(settlement).toEqual({ status: "completed", artifact: 1 });
    expect(driver.artifactPublishes[0]?.path).toBe("out/book.pdf");
  });
});
