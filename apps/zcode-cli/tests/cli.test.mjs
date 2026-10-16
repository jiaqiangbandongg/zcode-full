import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const cliPackage = resolve(root, "packages/cli");
const cli = resolve(cliPackage, "dist/zcode.cjs");
const packageJson = JSON.parse(await readFile(resolve(cliPackage, "package.json"), "utf8"));

const runCli = async (args) =>
  execFileAsync(process.execPath, [cli, ...args]);

test("prints version", async () => {
  const { stdout } = await runCli(["--version"]);
  assert.equal(stdout.trim(), packageJson.version);
});

test("rejects removed hello command", async () => {
  await assert.rejects(
    runCli(["hello"]),
    (error) => error.code === 1 && /Unknown command: hello/.test(error.stderr),
  );
});

test("prints JSON doctor payload", async () => {
  const { stdout } = await runCli(["doctor", "--json"]);
  const payload = JSON.parse(stdout);
  assert.equal(payload.cli.name, "zcode");
  assert.equal(payload.cli.processName, "zcode-cli");
  assert.equal(payload.runtime.processTitle, "zcode-cli");
  assert.equal(payload.packaging.default, "node-bundle");
  assert.equal(payload.packaging.sea, "optional");
});
