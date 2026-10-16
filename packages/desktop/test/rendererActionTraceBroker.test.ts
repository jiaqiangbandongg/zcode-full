import { describe, expect, it, vi } from "vitest";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { RendererActionTraceBatchV1 } from "@zcode/shared";
import { createRendererActionTraceBroker } from "../src/main/rendererActionTraceBroker.js";

function createBatch(): RendererActionTraceBatchV1 {
  return {
    version: 1,
    rendererInstanceId: "renderer-test",
    sequence: 1,
    droppedSinceLastFlush: 0,
    resource: {
      serviceName: "zcode-desktop-renderer",
      serviceVersion: "1.0.0",
      deploymentEnvironment: "test",
      rendererInstanceId: "renderer-test",
    },
    spans: [
      {
        traceId: "1".repeat(32),
        spanId: "2".repeat(16),
        name: "ui_action",
        startTimeUnixMs: 1_000,
        endTimeUnixMs: 1_125,
        status: "ok",
        attributes: {
          feature_id: "settings.memory",
          action: "toggle_memory",
          catalog_group: "settings",
          operation_kind: "preference",
          surface: "settings.memory",
          trigger: "switch",
          outcome: "completed",
          result_source: "shared_settings",
          state_after: "enabled",
          action_id: "11111111-1111-4111-8111-111111111111",
        },
      },
    ],
  };
}

describe("renderer action trace broker", () => {
  it("exports a completed renderer span without changing ids or timestamps", async () => {
    const exported: ReadableSpan[][] = [];
    const exporter: SpanExporter = {
      export: (spans, callback) => {
        exported.push(spans);
        callback({ code: 0 });
      },
      shutdown: async () => undefined,
    };
    const broker = createRendererActionTraceBroker({
      exporter,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });

    expect(broker.enqueue(createBatch())).toBe(true);
    await broker.flush();

    const span = exported[0]?.[0];
    expect(span?.spanContext()).toMatchObject({
      traceId: "1".repeat(32),
      spanId: "2".repeat(16),
    });
    expect(span?.startTime).toEqual([1, 0]);
    expect(span?.endTime).toEqual([1, 125_000_000]);
    expect(span?.attributes).toMatchObject({
      feature_id: "settings.memory",
      action: "toggle_memory",
    });
  });

  it("rejects malformed or oversized batches without calling the exporter", async () => {
    const exporter: SpanExporter = {
      export: vi.fn(),
      shutdown: async () => undefined,
    };
    const broker = createRendererActionTraceBroker({
      exporter,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });

    expect(broker.enqueue({ ...createBatch(), version: 2 } as never)).toBe(false);
    expect(
      broker.enqueue({
        ...createBatch(),
        rendererInstanceId: "x".repeat(300_000),
      } as never),
    ).toBe(false);
    await broker.flush();
    expect(exporter.export).not.toHaveBeenCalled();
  });

  it("bounds shutdown and records batches dropped after the deadline", async () => {
    const warn = vi.fn();
    const exporter: SpanExporter = {
      export: vi.fn(),
      shutdown: vi.fn(async () => undefined),
    };
    (exporter.export as ReturnType<typeof vi.fn>).mockImplementation(() => {
      // 模拟 OTLP exporter 永不回调，验证退出不会继续等待网络。
    });
    const broker = createRendererActionTraceBroker({
      exporter,
      shutdownTimeoutMs: 20,
      logger: { debug: vi.fn(), warn },
    });

    expect(broker.enqueue(createBatch())).toBe(true);
    await Promise.resolve();
    for (let sequence = 2; sequence <= 33; sequence += 1) {
      expect(broker.enqueue({ ...createBatch(), sequence })).toBe(true);
    }

    const startedAt = Date.now();
    await broker.shutdown();

    expect(Date.now() - startedAt).toBeLessThan(200);
    expect(warn).toHaveBeenCalledWith(
      "[renderer-action-trace] shutdown deadline exceeded; dropping queued batches",
      expect.objectContaining({ droppedBatchCount: 32 }),
    );
    expect(exporter.shutdown).not.toHaveBeenCalled();
  });

  it("retries one failed export and serializes concurrent flush calls", async () => {
    let attempts = 0;
    const exporter: SpanExporter = {
      export: (_spans, callback) => {
        attempts += 1;
        callback({ code: attempts === 1 ? 1 : 0 });
      },
      forceFlush: vi.fn(async () => undefined),
      shutdown: async () => undefined,
    };
    const broker = createRendererActionTraceBroker({
      exporter,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });

    broker.enqueue(createBatch());
    await Promise.all([broker.flush(), broker.flush()]);

    expect(attempts).toBe(2);
    expect(exporter.forceFlush).toHaveBeenCalledTimes(1);
  });

  it("bounds a forceFlush that never returns", async () => {
    const warn = vi.fn();
    const exporter: SpanExporter = {
      export: (_spans, callback) => callback({ code: 0 }),
      forceFlush: vi.fn(() => new Promise<void>(() => {})),
      shutdown: async () => undefined,
    };
    const broker = createRendererActionTraceBroker({
      exporter,
      flushTimeoutMs: 20,
      logger: { debug: vi.fn(), warn },
    });

    broker.enqueue(createBatch());
    await broker.flush();

    expect(warn).toHaveBeenCalledWith(
      "[renderer-action-trace] exporter forceFlush exceeded deadline; continuing",
    );
  });

  it("does not retry a timed-out batch and ignores its late callback", async () => {
    let completeLateExport: (() => void) | undefined;
    const exportedSpanIds: string[] = [];
    const warn = vi.fn();
    const exporter: SpanExporter = {
      export: (spans, callback) => {
        const spanId = spans[0]?.spanContext().spanId;
        if (spanId) exportedSpanIds.push(spanId);
        if (exportedSpanIds.length === 1) {
          completeLateExport = () => callback({ code: 0 });
          return;
        }
        callback({ code: 0 });
      },
      shutdown: async () => undefined,
    };
    const broker = createRendererActionTraceBroker({
      exporter,
      exportTimeoutMs: 20,
      logger: { debug: vi.fn(), warn },
    });

    expect(broker.enqueue(createBatch())).toBe(true);
    expect(
      broker.enqueue({
        ...createBatch(),
        sequence: 2,
        spans: [{ ...createBatch().spans[0]!, spanId: "3".repeat(16) }],
      }),
    ).toBe(true);
    await broker.flush();

    expect(exportedSpanIds).toEqual(["2".repeat(16), "3".repeat(16)]);
    expect(warn).toHaveBeenCalledWith(
      "[renderer-action-trace] batch export failed",
      expect.objectContaining({ sequence: 1, failureKind: "timeout" }),
    );
    completeLateExport?.();
    await Promise.resolve();
    expect(exportedSpanIds).toEqual(["2".repeat(16), "3".repeat(16)]);
  });

  it("rejects enqueue during and after repeated shutdown", async () => {
    const exporter: SpanExporter = {
      export: (_spans, callback) => callback({ code: 0 }),
      shutdown: vi.fn(async () => undefined),
    };
    const broker = createRendererActionTraceBroker({
      exporter,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });

    const firstShutdown = broker.shutdown();
    expect(broker.enqueue(createBatch())).toBe(false);
    const secondShutdown = broker.shutdown();
    await Promise.all([firstShutdown, secondShutdown]);
    expect(exporter.shutdown).toHaveBeenCalledTimes(1);
    expect(broker.enqueue(createBatch())).toBe(false);
  });
});
