import { createHash } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { MigrationBackupTable } from "./contract.js";

export interface TableSnapshot extends MigrationBackupTable {
  values: SQLInputValue[][];
}

export function identifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`Invalid SQL identifier: ${value}`);
  return `"${value}"`;
}

export function contentHash(rows: readonly SQLInputValue[][]): string {
  const encoded = rows
    .map((row) =>
      JSON.stringify(row, (_key, value: unknown) => {
        if (typeof value === "bigint") return { integer: value.toString() };
        if (value instanceof Uint8Array) return { blob: Buffer.from(value).toString("hex") };
        return value;
      }),
    )
    .sort();
  return createHash("sha256").update(JSON.stringify(encoded)).digest("hex");
}

export function snapshotTable(
  db: DatabaseSync,
  name: string,
  selectedColumns?: string[],
): TableSnapshot {
  const columns =
    selectedColumns ??
    (db.prepare(`pragma table_info(${identifier(name)})`).all() as { name: string }[]).map(
      (row) => row.name,
    );
  const values: SQLInputValue[][] = [];
  if (columns.length) {
    const statement = db.prepare(
      `select ${columns.map(identifier).join(",")} from ${identifier(name)}`,
    );
    statement.setReadBigInts(true);
    for (const row of statement.iterate()) values.push(columns.map((column) => row[column]!));
  }
  return { name, columns, rows: values.length, hash: contentHash(values), values };
}

export function insertSnapshot(db: DatabaseSync, table: TableSnapshot): void {
  if (!table.columns.length) return;
  const statement = db.prepare(
    `insert into ${identifier(table.name)} (${table.columns.map(identifier).join(",")}) values (${table.columns.map(() => "?").join(",")})`,
  );
  for (const values of table.values) statement.run(...values);
}
