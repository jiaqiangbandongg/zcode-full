import type { DatabaseSync } from "node:sqlite";
import type { SqliteMigrationsContract } from "./contract.js";

export async function exampleSqliteMigrations(
  port: SqliteMigrationsContract,
  db: DatabaseSync,
  backupDirectory: string,
): Promise<void> {
  await port.migrate(
    db,
    [
      {
        id: "example_add_title",
        appVersion: "1",
        touchedTables: ["example"],
        sql: "create table if not exists example (id text primary key, title text)",
      },
    ],
    { database: "example", backupDirectories: [backupDirectory] },
  );
}
