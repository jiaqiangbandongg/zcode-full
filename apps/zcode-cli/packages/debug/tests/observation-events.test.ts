import { appendFile, mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDebugApp } from "../server/index.js";
import {
  createObservationEventStream,
  fingerprintObservationSources,
} from "../server/observation-events.js";

describe("observation events", () => {
  it("emits SSE changes when observed JSONL files change", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-debug-events-"));
    const logDir = join(root, "log");
    const logPath = join(logDir, "debug.jsonl");
    await mkdir(logDir);
    await writeFile(logPath, `${JSON.stringify({ message: "before" })}\n`, "utf8");

    const stream = createObservationEventStream(
      {
        logDir,
        dbPath: join(root, "missing.sqlite"),
      },
      { intervalMs: 50 },
    );
    const reader = stream.getReader();

    try {
      await readUntil(reader, "event: hello");
      await appendFile(logPath, `${JSON.stringify({ message: "after" })}\n`, "utf8");
      const eventText = await readUntil(reader, "event: change");

      expect(eventText).toContain("结构化日志");
      expect(eventText).toContain(logDir);
    } finally {
      await reader.cancel();
    }
  });

  it("exposes the observation event stream from the API", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-debug-events-api-"));
    const logDir = join(root, "log");
    await mkdir(logDir);

    const app = createDebugApp();
    const response = await app.request(
      `/api/observations/events?logDir=${encodeURIComponent(logDir)}&dbPath=${encodeURIComponent(
        join(root, "missing.sqlite"),
      )}`,
    );
    const reader = response.body?.getReader();
    if (!reader) throw new Error("response body is missing");

    try {
      const eventText = await readUntil(reader, "event: hello");

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(eventText).toContain("event: hello");
    } finally {
      await reader.cancel();
    }
  });

  it("includes SQLite WAL companion files in the fingerprint set", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-debug-events-sqlite-"));
    const dbPath = join(root, "db.sqlite");
    const sources = await fingerprintObservationSources({
      logDir: join(root, "missing-log"),
      dbPath,
    });

    expect(sources.map((source) => source.path)).toEqual(
      expect.arrayContaining([dbPath, `${dbPath}-wal`, `${dbPath}-shm`]),
    );
  });

  it("does not treat SQLite SHM mtime churn as a source change", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-debug-events-sqlite-shm-"));
    const dbPath = join(root, "db.sqlite");
    const shmPath = `${dbPath}-shm`;
    await writeFile(shmPath, "shared-memory-index", "utf8");

    const before = await fingerprintObservationSources({
      logDir: join(root, "missing-log"),
      dbPath,
    });
    await utimes(
      shmPath,
      new Date("2026-05-04T01:00:00.000Z"),
      new Date("2026-05-04T01:00:00.000Z"),
    );
    const after = await fingerprintObservationSources({
      logDir: join(root, "missing-log"),
      dbPath,
    });

    const beforeShm = before.find((source) => source.path === shmPath);
    const afterShm = after.find((source) => source.path === shmPath);
    expect(afterShm?.signature).toBe(beforeShm?.signature);
  });
});

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  pattern: string,
): Promise<string> {
  let text = "";
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const remainingMs = Math.max(deadline - Date.now(), 1);
    const result = await Promise.race([
      reader.read(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), remainingMs)),
    ]);
    if (result === null) break;
    if (result.done) break;
    text += Buffer.from(result.value).toString("utf8");
    if (text.includes(pattern)) return text;
  }
  throw new Error(`Timed out waiting for ${pattern}. Read: ${text}`);
}
