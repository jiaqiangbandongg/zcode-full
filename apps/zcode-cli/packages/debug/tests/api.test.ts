import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDebugApp } from "../server/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("debug API", () => {
  it("returns trace details through Hono", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-debug-api-"));
    roots.push(root);
    const eventPath = join(root, "events.jsonl");
    await writeFile(
      eventPath,
      `${JSON.stringify({
        id: "evt-api",
        type: "turn_started",
        timestamp: "2026-05-04T02:00:00.000Z",
        traceId: "trace-api",
        sessionId: "session-api",
        payload: { input: "hello" },
      })}\n`,
      "utf8",
    );

    const app = createDebugApp();
    // 漏传 logDir 会扫描操作者的真实日志，导致全量并发时超时；所有数据源都必须指向夹具。
    const response = await app.request(
      `/api/traces/trace-api?logDir=${encodeURIComponent(join(root, "missing-logs"))}&eventPath=${encodeURIComponent(eventPath)}&dbPath=${encodeURIComponent(
        join(root, "missing.sqlite"),
      )}`,
    );
    const body = (await response.json()) as {
      traceId: string;
      timeline: unknown[];
      sources: { kind: string; path: string }[];
    };

    expect(response.status).toBe(200);
    expect(body.traceId).toBe("trace-api");
    expect(body.timeline).toHaveLength(1);
    expect(body.sources.find((source) => source.kind === "log")?.path).toBe(
      join(root, "missing-logs"),
    );
  });

  it("returns a stable disabled status when network capture is not attached", async () => {
    const app = createDebugApp();
    const response = await app.request("/api/network/status");
    const body = (await response.json()) as { enabled: boolean; running: boolean };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      enabled: false,
      running: false,
    });
  });
});
