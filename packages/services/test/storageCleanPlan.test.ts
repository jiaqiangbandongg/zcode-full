import { describe, expect, it } from "vitest";
import { planStorageClean, SUBAGENT_ACTIVE_WINDOW_MS } from "../src/storage/domain/cleanPlan.js";

const context = { rootId: "home" as const, hasCustomDataBaseDir: false };
const now = new Date(2026, 8, 10, 15, 0, 0).getTime();
const yesterday = now - 24 * 60 * 60 * 1000;
const candidate = (relativePath: string, mtimeMs = yesterday, bytes = 1) => ({
  relativePath,
  bytes,
  mtimeMs,
});

describe("planStorageClean", () => {
  it("refuses non-cleanable categories", () => {
    const plan = planStorageClean({
      categoryId: "sessionStore",
      candidates: [candidate("v2/tasks-index.sqlite")],
      context,
      now,
    });
    expect(plan).toEqual({ targets: [], skippedCount: 1 });
  });

  it("only deletes candidates classified into the requested category and never protected files", () => {
    const plan = planStorageClean({
      categoryId: "devTraces",
      candidates: [
        candidate("v2/dev/stdio-traffic/a/x.ndjson"),
        candidate("v2/dev/zcode-stdio-tap.json"),
        candidate("v2/logs/a.log"),
      ],
      context,
      now,
    });
    expect(plan.targets.map((t) => t.relativePath)).toEqual(["v2/dev/stdio-traffic/a/x.ndjson"]);
    expect(plan.skippedCount).toBe(2);
  });

  it("keeps today's log files and the live crash directory", () => {
    const plan = planStorageClean({
      categoryId: "logs",
      candidates: [
        candidate("v2/logs/2026-09-09.log", yesterday),
        candidate("v2/logs/2026-09-10.log", now - 60_000),
        candidate("v2/crash/live/current.dmp", yesterday),
        candidate("cli/log/zcode-2026-09-01.jsonl", yesterday - 8 * 24 * 3600 * 1000),
      ],
      context,
      now,
    });
    expect(plan.targets.map((t) => t.relativePath)).toEqual([
      "v2/logs/2026-09-09.log",
      "cli/log/zcode-2026-09-01.jsonl",
    ]);
  });

  it("only deletes subagent transcripts and skips session directories touched within 24h", () => {
    const recent = now - SUBAGENT_ACTIVE_WINDOW_MS + 1;
    const old = yesterday - SUBAGENT_ACTIVE_WINDOW_MS;
    const plan = planStorageClean({
      categoryId: "subagentTranscripts",
      candidates: [
        candidate("cli/agents/sess_old/agent_1/transcript.jsonl", old),
        candidate("cli/agents/sess_old/agent_1/output.txt", old),
        candidate("cli/agents/sess_hot/agent_2/transcript.jsonl", old),
        candidate("cli/agents/sess_hot/agent_2/metadata.json", recent),
      ],
      context,
      now,
    });
    expect(plan.targets.map((t) => t.relativePath)).toEqual([
      "cli/agents/sess_old/agent_1/transcript.jsonl",
    ]);
    expect(plan.skippedCount).toBe(3);
  });

  it("refuses to clean tool outputs and temporary caches", () => {
    const plan = planStorageClean({
      categoryId: "toolOutputs",
      candidates: [candidate("cli/exec/sess_1/out.log"), candidate("cli/artifacts/sess_1/a.json")],
      context,
      now,
    });
    expect(plan).toEqual({ targets: [], skippedCount: 2 });
  });

  it("does not let backups cleaning touch live databases listed by the shallow scope", () => {
    const plan = planStorageClean({
      categoryId: "backups",
      candidates: [
        candidate("cli/db/db.sqlite"),
        candidate("cli/db/db.sqlite-wal"),
        candidate("cli/db/db.sqlite.bak-1"),
        candidate("v2/setting.json"),
        candidate("v2/setting.json.corrupt-1"),
        candidate("v2/tasks-index.sqlite"),
      ],
      context,
      now,
    });
    expect(plan.targets.map((t) => t.relativePath)).toEqual([
      "cli/db/db.sqlite.bak-1",
      "v2/setting.json.corrupt-1",
    ]);
  });
});
