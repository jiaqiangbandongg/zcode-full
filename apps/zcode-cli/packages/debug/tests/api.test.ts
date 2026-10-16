import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDebugApp } from "../server/index.js";

describe("debug API", () => {
  it("returns trace details through Hono", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-debug-api-"));
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
    const response = await app.request(
      `/api/traces/trace-api?eventPath=${encodeURIComponent(eventPath)}&dbPath=${encodeURIComponent(
        join(root, "missing.sqlite"),
      )}`,
    );
    const body = (await response.json()) as { traceId: string; timeline: unknown[] };

    expect(response.status).toBe(200);
    expect(body.traceId).toBe("trace-api");
    expect(body.timeline).toHaveLength(1);
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
