import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import { SESSION_ENTRY_MODEL_SELECTION, type SessionId } from "@zcode/contracts";

/** 旧数据必须从磁盘播种；新版 writer 会包装新字段，不能拿它伪造升级前状态。 */
export async function createLegacySelectionStoreFixture() {
  const root = await mkdtemp(join(tmpdir(), "app-legacy-selection-"));
  const dbPath = join(root, "sessions.sqlite");
  let store = createSqliteSessionStore({ dbPath });
  const db = new DatabaseSync(dbPath);
  return {
    get store() {
      return store;
    },
    seedLegacy(sessionID: SessionId, data: unknown) {
      db.prepare(
        "insert into session_entry(id, session_id, type, time_created, time_updated, data) values(?,?,?,?,?,?)",
      ).run(
        `${sessionID}:runtime-model-selection`,
        sessionID,
        SESSION_ENTRY_MODEL_SELECTION,
        2,
        2,
        JSON.stringify(data),
      );
      // Todo109：播种旧格式后关闭并重开，迁移必须由启动门禁触发，不再由 resume 补迁。
      store.close();
      db.exec("DELETE FROM schema_migration WHERE id='0020_provider_model_selection'");
      store = createSqliteSessionStore({ dbPath });
    },
    async dispose() {
      db.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
