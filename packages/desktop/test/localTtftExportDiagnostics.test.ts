import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { once } from "node:events";
import { expect, it } from "vitest";
import { createLocalTtftExporter } from "../src/main/localTtftExporter.js";
import type { LocalTtftRecord } from "@zcode/shared";

it("最终 OTLP：根未结束也有阶段，重复乱序不重复样本，失败不进入成功分布", async () => {
  const receiver = spawn(
    process.execPath,
    [resolve("packages/desktop/scripts/ttft-otlp-receiver.mjs"), "0"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const [ready] = await once(receiver.stdout!, "data");
  const endpoint = `http://127.0.0.1:${String(ready).trim().split(":").at(-1)}`;
  const exporter = createLocalTtftExporter({
    now: () => 1000,
    env: { OTEL_EXPORTER_OTLP_ENDPOINT: endpoint },
    version: "test",
    logger: { warn() {} },
  });
  const base: LocalTtftRecord = {
    version: 1,
    observationId: "e0b15fc2-3a50-4d73-854d-61fa148cbfd0",
    kind: "checkpoint",
    outcome: "unclosed",
    start: 1000,
    end: 1200,
    quality: "missing",
    sendMode: "queued",
    visibility: "foreground",
    timingReliable: true,
    intervals: [{ stage: "renderer_prepare", start: 1000, end: 1010, source: "renderer" }],
    details: [
      {
        id: "context:1",
        stage: "context",
        start: 1050,
        end: 1150,
        source: "cli",
        outcome: "completed",
      },
      {
        id: "hooks:1",
        stage: "hooks",
        start: 1075,
        end: 1125,
        source: "cli",
        outcome: "completed",
      },
      { id: "mcp:open", stage: "mcp", start: 1180, source: "cli" },
    ],
  };
  let sequence = 0;
  const send = (record: LocalTtftRecord) =>
    exporter.enqueue({
      version: 1,
      rendererInstanceId: "renderer",
      sequence: sequence++,
      records: [record],
      dropped: 0,
    });
  type Data = {
    data: {
      resourceSpans?: Array<{
        scopeSpans: Array<{
          spans: {
            name: string;
            spanId: string;
            attributes: { key: string; value: { doubleValue?: number; intValue?: string } }[];
          }[];
        }>;
      }>;
      resourceMetrics?: Array<{
        scopeMetrics: Array<{
          metrics: { name: string; histogram?: { dataPoints: { count: string }[] } }[];
        }>;
      }>;
    };
  };
  const read = async () => (await (await fetch(`${endpoint}/records`)).json()) as Data[];
  const spans = async () =>
    (await read())
      .flatMap((r) => r.data.resourceSpans ?? [])
      .flatMap((r) => r.scopeSpans)
      .flatMap((r) => r.spans);
  try {
    send({ ...base, checkpointId: "stage:1" });
    await expect
      .poll(async () => (await spans()).some((span) => span.name === "local_ttft.prepare.context"))
      .toBe(true);
    expect((await spans()).some((span) => span.name === "local_ttft")).toBe(false);
    send({ ...base, kind: "first_output", outcome: "success", end: 1500, quality: "complete" });
    send({ ...base, checkpointId: "stage:2" });
    send({ ...base, kind: "first_output", outcome: "success", end: 1500, quality: "complete" });
    send({
      ...base,
      observationId: "f0b15fc2-3a50-4d73-854d-61fa148cbfd0",
      kind: "excluded",
      outcome: "failed",
    });
    await expect
      .poll(async () => (await read()).some((r) => r.data.resourceMetrics?.length), {
        timeout: 10000,
      })
      .toBe(true);
    const exported = await spans();
    expect(exported.filter((span) => span.name === "local_ttft")).toHaveLength(1);
    const unexplained = exported
      .find((span) => span.name === "local_ttft")
      ?.attributes.find((attribute) => attribute.key === "unattributed_ms")?.value;
    expect(Number(unexplained?.doubleValue ?? unexplained?.intValue)).toBe(390);
    // 每个输入各一个 context，重复累计检查点和根不会增发。
    expect(exported.filter((span) => span.name === "local_ttft.prepare.context")).toHaveLength(2);
    const histograms = (await read())
      .flatMap((r) => r.data.resourceMetrics ?? [])
      .flatMap((r) => r.scopeMetrics)
      .flatMap((r) => r.metrics)
      .filter((m) => m.name === "zcode.local_ttft.duration");
    expect(
      histograms
        .flatMap((h) => h.histogram?.dataPoints ?? [])
        .reduce((sum, point) => sum + Number(point.count), 0),
    ).toBe(1);
  } finally {
    await exporter.shutdown();
    receiver.kill();
    await once(receiver, "exit");
  }
});

it("exporter 超时与队列满可观测，连续提交仍有界且不等待网络", async () => {
  const receiver = spawn(
    process.execPath,
    [resolve("packages/desktop/scripts/ttft-otlp-receiver.mjs"), "0", "5000"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const [ready] = await once(receiver.stdout!, "data");
  const endpoint = `http://127.0.0.1:${String(ready).trim().split(":").at(-1)}`;
  const exporter = createLocalTtftExporter({
    now: () => 1000,
    env: { OTEL_EXPORTER_OTLP_ENDPOINT: endpoint },
    version: "test",
    logger: { warn() {} },
  });
  try {
    const started = performance.now();
    for (let sequence = 0; sequence < 100; sequence++)
      exporter.enqueue({
        version: 1,
        rendererInstanceId: "r",
        sequence,
        dropped: 0,
        records: [
          {
            version: 1,
            observationId: crypto.randomUUID(),
            kind: "start",
            outcome: "success",
            quality: "missing",
            start: 100,
            end: 100,
            intervals: [],
          },
        ],
      });
    expect(performance.now() - started).toBeLessThan(500);
    await expect
      .poll(
        async () => {
          const data = (await (await fetch(`${endpoint}/records`)).json()) as Array<{
            data: unknown;
          }>;
          const metrics = data.map((record) => JSON.stringify(record.data)).join("\n");
          return (
            metrics.includes('"stringValue":"queue_full"') &&
            metrics.includes('"stringValue":"trace_export"')
          );
        },
        { timeout: 10000 },
      )
      .toBe(true);
  } finally {
    await exporter.shutdown();
    receiver.kill();
    await once(receiver, "exit");
  }
});
