import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  collectTypeScriptFiles,
  countLines,
  formatReport,
  isTestSourceFile,
  measureTypeScriptFiles,
} from "../scripts/count-ts-lines.mjs";

test("counts empty files and trailing newlines consistently", () => {
  assert.equal(countLines(""), 0);
  assert.equal(countLines("one"), 1);
  assert.equal(countLines("one\n"), 1);
  assert.equal(countLines("one\r\ntwo\r\n"), 2);
});

test("collects TypeScript files and skips generated directories and excluded packages", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zcode-count-ts-lines-"));
  t.after(() => rm(root, { force: true, recursive: true }));

  await mkdir(join(root, "packages", "core", "src"), { recursive: true });
  await mkdir(join(root, "packages", "debug", "src"), { recursive: true });
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "src", "tests"), { recursive: true });
  await mkdir(join(root, "src", "__tests__"), { recursive: true });
  await mkdir(join(root, "dist"), { recursive: true });
  await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(root, "src", "agent.ts"), "one\n");
  await writeFile(join(root, "src", "agent.test.ts"), "one\n");
  await writeFile(join(root, "src", "agent.spec.tsx"), "one\n");
  await writeFile(join(root, "src", "view.tsx"), "one\ntwo\n");
  await writeFile(join(root, "src", "tests", "helper.ts"), "one\n");
  await writeFile(join(root, "src", "__tests__", "view.tsx"), "one\n");
  await writeFile(join(root, "src", "ignore.js"), "one\n");
  await writeFile(join(root, "dist", "built.ts"), "one\n");
  await writeFile(join(root, "node_modules", "pkg", "dep.ts"), "one\n");
  await writeFile(join(root, "packages", "core", "src", "index.ts"), "one\n");
  await writeFile(join(root, "packages", "debug", "src", "debug.ts"), "one\n");

  const files = await collectTypeScriptFiles(root);

  assert.deepEqual(
    files.map((file) => file.relativePath),
    ["packages/core/src/index.ts", "src/agent.ts", "src/view.tsx"],
  );
});

test("identifies colocated and directory-based test files", () => {
  assert.equal(isTestSourceFile("src/agent.test.ts"), true);
  assert.equal(isTestSourceFile("src/agent.spec.tsx"), true);
  assert.equal(isTestSourceFile("src/tests/helper.ts"), true);
  assert.equal(isTestSourceFile("src\\tests\\helper.ts"), true);
  assert.equal(isTestSourceFile("src/__tests__/helper.tsx"), true);
  assert.equal(isTestSourceFile("src/agent.ts"), false);
});

test("formats measurements by descending line count", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zcode-count-ts-lines-"));
  t.after(() => rm(root, { force: true, recursive: true }));

  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "small.ts"), "one\n");
  await writeFile(join(root, "src", "large.tsx"), "one\ntwo\nthree\n");

  const report = formatReport(await measureTypeScriptFiles(root));

  assert.match(report, /Files: 2/);
  assert.match(report, /Total lines: 4/);
  assert.ok(report.indexOf("src/large.tsx") < report.indexOf("src/small.ts"));
});
