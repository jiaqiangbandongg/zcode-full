import { test } from "node:test";
import assert from "node:assert/strict";
import { assertAdditiveSchema } from "../sqlite-schema-contract.mjs";
const baseline =
  "CREATE TABLE tasks(workspace_key TEXT,task_id TEXT,PRIMARY KEY(workspace_key,task_id)); CREATE INDEX task_idx ON tasks(task_id);";
test("nullable/defaulted additions preserve old writes and composite identity", () => {
  assert.doesNotThrow(() =>
    assertAdditiveSchema(
      baseline,
      baseline +
        "ALTER TABLE tasks ADD COLUMN project_id TEXT; ALTER TABLE tasks ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;",
    ),
  );
});
for (const [name, sql] of [
  ["column removal", "CREATE TABLE tasks(task_id TEXT); CREATE INDEX task_idx ON tasks(task_id);"],
  [
    "identity change",
    "CREATE TABLE tasks(workspace_key TEXT,task_id TEXT PRIMARY KEY); CREATE INDEX task_idx ON tasks(task_id);",
  ],
  ["required addition", baseline + "ALTER TABLE tasks ADD COLUMN host TEXT NOT NULL;"],
  [
    "index removal",
    "CREATE TABLE tasks(workspace_key TEXT,task_id TEXT,PRIMARY KEY(workspace_key,task_id));",
  ],
])
  test(`rejects ${name}`, () => assert.throws(() => assertAdditiveSchema(baseline, sql)));

test("preserves automatic UNIQUE keys and their collation/order", () => {
  const old = "CREATE TABLE tasks(id TEXT, title TEXT COLLATE NOCASE, UNIQUE(id,title DESC));";
  for (const next of [
    "CREATE TABLE tasks(id TEXT,title TEXT COLLATE NOCASE);",
    "CREATE TABLE tasks(id TEXT,title TEXT,UNIQUE(id,title DESC));",
    "CREATE TABLE tasks(id TEXT,title TEXT COLLATE NOCASE,UNIQUE(id,title ASC));",
    "CREATE TABLE tasks(id TEXT,title TEXT COLLATE NOCASE,UNIQUE(title DESC,id));",
  ])
    assert.throws(() => assertAdditiveSchema(old, next));
  assert.doesNotThrow(() =>
    assertAdditiveSchema(old, old + "ALTER TABLE tasks ADD COLUMN extra TEXT;"),
  );
});
test("rejects removal/change/addition of CHECK and automatic UNIQUE on old tables", () => {
  const old =
    "CREATE TABLE tasks(id TEXT CHECK(length(id) > 0), value TEXT CHECK(value <> 'CHECK(fake)'));";
  for (const next of [
    "CREATE TABLE tasks(id TEXT, value TEXT);",
    "CREATE TABLE tasks(id TEXT CHECK(length(id) >= 0), value TEXT CHECK(value <> 'CHECK(fake)'));",
    "CREATE TABLE tasks(id TEXT CHECK(length(id) > 0) UNIQUE, value TEXT CHECK(value <> 'CHECK(fake)'));",
    old + "ALTER TABLE tasks ADD COLUMN extra TEXT CHECK(extra <> 'x');",
  ])
    assert.throws(() => assertAdditiveSchema(old, next));
  assert.doesNotThrow(() =>
    assertAdditiveSchema(old, old + "ALTER TABLE tasks ADD COLUMN extra TEXT;"),
  );
});
test("SQL normalization preserves string literal case in indexes and CHECK", () => {
  const table = "CREATE TABLE tasks(id TEXT, phase TEXT);";
  assert.throws(() =>
    assertAdditiveSchema(
      table + "CREATE INDEX status ON tasks(id) WHERE phase='COMPLETE';",
      table + "CREATE INDEX status ON tasks(id) WHERE phase='complete';",
    ),
  );
  assert.throws(() =>
    assertAdditiveSchema(
      "CREATE TABLE tasks(phase TEXT CHECK(phase='COMPLETE'));",
      "CREATE TABLE tasks(phase TEXT CHECK(phase='complete'));",
    ),
  );
  assert.doesNotThrow(() =>
    assertAdditiveSchema(
      table + "CREATE INDEX status ON tasks(id) WHERE phase='complete';",
      table + "create index status on tasks(id) where phase = 'complete';",
    ),
  );
});
