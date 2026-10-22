import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const PROJECT_UPGRADE_ORDER_SPEC = "conversation-session-project-upgrade-order.test.ts";
export const SAVED_PROJECT_NAMES = ["z-saved", "b-saved", "empty-saved"];
export const MIGRATED_REMOTE_NAME = "upgrade-remote";
export const LEGACY_PINNED_TASK_IDS = ["e2e-legacy-pinned", "e2e-legacy-imported-pinned"];
export const CURRENT_IMPORTED_TASK_ID = "e2e-current-imported";

/** 旧执行后端与当前后端的导入会话必须分开：migration_source 不决定可见性。 */
export function seedLegacyProviderTasks(db: DatabaseSync, workspacePath: string) {
  const insert = db.prepare(`INSERT INTO tasks
    (workspace_key,workspace_path,task_id,title,task_status,provider,migration_source,created_at,updated_at,pinned)
    VALUES(?,?,?,?,'completed',?,?,?,?,1)`);
  for (const [index, id] of LEGACY_PINNED_TASK_IDS.entries()) {
    insert.run(
      workspacePath,
      workspacePath,
      id,
      `E2E_LEGACY_${index}`,
      "claude",
      index ? "claudeCode" : null,
      10,
      20,
    );
  }
  const now = Date.now();
  insert.run(
    workspacePath,
    workspacePath,
    CURRENT_IMPORTED_TASK_ID,
    "E2E_CURRENT_IMPORTED",
    "glm",
    "claudeCode",
    now,
    now,
  );
}

/** 先写旧版数据，再让真实建窗前迁移建立 position；不能在启动后伪造迁移结果。 */
export async function seedProjectUpgradeOrderFixture(home: string, settingsFile: string) {
  const workspace = join(home, "ZCodeProject");
  const root = join(workspace, ".zcode-e2e", "project-upgrade-order");
  const defaultPath = join(home, ".zcode", "workspace", "default");
  await mkdir(defaultPath, { recursive: true });
  const paths = [
    ...SAVED_PROJECT_NAMES,
    "a-history",
    "archived-history",
    "deleted-history",
    "recent-only",
  ].map((name) => join(root, name));
  await Promise.all(paths.map((path) => mkdir(path, { recursive: true })));
  const settings = JSON.parse(await readFile(settingsFile, "utf8"));
  await writeFile(
    settingsFile,
    JSON.stringify({
      ...settings,
      lastWorkspaceSession: [workspace, defaultPath, ...paths.slice(0, 3)].flatMap(
        (workspacePath, index) => [
          {
            kind: "local",
            workspacePurpose: "project",
            workspacePath,
          },
          ...(index === 0
            ? [
                {
                  kind: "remote",
                  workspacePurpose: "project",
                  workspacePath: `/${MIGRATED_REMOTE_NAME}`,
                  target: { kind: "ssh", host: "127.0.0.1", port: 1, username: "dev" },
                  lastOpenedAt: 1,
                  lastConnectionStatus: "failed",
                },
              ]
            : []),
        ],
      ),
      recentProjects: [...paths].reverse(),
      lastActiveTabIndex: 0,
    }),
  );
  // node:sqlite 仅有同步连接；此时 app/Host 尚未启动，数据库没有并发写者。
  const db = new DatabaseSync(join(home, ".zcode", "v2", "tasks-index.sqlite"));
  try {
    db.exec(`CREATE TABLE tasks (
      workspace_key TEXT NOT NULL, workspace_path TEXT NOT NULL, workspace_identity TEXT,
      task_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', task_status TEXT, provider TEXT,
      mode TEXT NOT NULL DEFAULT 'build', model TEXT, migration_source TEXT, forked_from_task_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, unread_at INTEGER,
      last_unread_at INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0,
      title_overridden INTEGER NOT NULL DEFAULT 0, meta_json TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY(workspace_key,task_id));`);
    const insert = db.prepare(`INSERT INTO tasks
      (workspace_key,workspace_path,task_id,title,task_status,provider,created_at,updated_at,archived)
      VALUES(?,?,?,?,'completed','glm',?,?,1)`);
    const now = Date.now();
    insert.run(defaultPath, defaultPath, "e2e-system-default", "E2E_SYSTEM_DEFAULT", now, now);
    db.exec("UPDATE tasks SET archived=0 WHERE task_id='e2e-system-default'");
    for (const name of ["a-history", "archived-history", "deleted-history", "b-saved", "z-saved"]) {
      const path = join(root, name);
      insert.run(path, path, `e2e-order-${name}`, `E2E_ORDER_${name}`, now, now);
    }
    db.exec(
      "UPDATE tasks SET archived=0,pinned=0,unread_at=7 WHERE task_id='e2e-order-a-history'; UPDATE tasks SET deleted=1 WHERE task_id='e2e-order-deleted-history'",
    );
    seedLegacyProviderTasks(db, join(root, "a-history"));
  } finally {
    db.close();
  }
}
