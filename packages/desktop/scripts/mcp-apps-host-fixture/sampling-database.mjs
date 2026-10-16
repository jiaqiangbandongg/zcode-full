import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

/** Electron 与 Agent 已退出后重新打开 SQLite，验证统计确实持久化而非内存投影。 */
export function verifySamplingDatabase(output) {
  const db = new DatabaseSync(join(output, "agent-data/session.sqlite"), { readOnly: true });
  try {
    const rows = db
      .prepare(
        "SELECT status, count(*) AS count, sum(computed_total_tokens) AS tokens FROM model_usage WHERE query_source = 'mcp_app_sampling' GROUP BY status",
      )
      .all();
    assert.deepEqual(rows.map((r) => r.status).sort(), ["cancelled", "completed", "error"]);
    const counts = Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
    assert.deepEqual(counts, { cancelled: 4, completed: 17, error: 1 });
    assert.equal(rows.find((row) => row.status === "completed").tokens, 255);
    const sessions = db
      .prepare(
        "SELECT count(DISTINCT session_id) AS count FROM model_usage WHERE query_source = 'mcp_app_sampling'",
      )
      .get().count;
    assert.equal(sessions, 2);
    return { rows, sessions };
  } finally {
    db.close();
  }
}
