import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { stageE2EAppOutput } from "./e2e/helpers/e2e-app-output-stage.js";

const testDirs: string[] = [];

afterEach(async () => {
  await Promise.all(testDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function createTestDirs() {
  const root = await mkdtemp(resolve("packages/desktop", ".e2e-stage-test-"));
  testDirs.push(root);
  return {
    destination: resolve(root, "destination"),
    root,
    source: resolve(root, "source"),
  };
}

describe("desktop E2E app output staging", () => {
  it("共享构建被类型检查原地覆盖后，递归快照保持原产物", async () => {
    const { destination, source } = await createTestDirs();
    await mkdir(resolve(source, "host"), { recursive: true });
    const sourceEntry = resolve(source, "host", "index.js");
    await writeFile(sourceEntry, "bundled-host");
    await stageE2EAppOutput(source, destination);
    await writeFile(sourceEntry, "unbundled-tsc-output");
    expect(await readFile(resolve(destination, "host", "index.js"), "utf8")).toBe("bundled-host");
  });

  it("用例修改隔离副本时，不污染共享构建或其他 shard", async () => {
    const { destination, root, source } = await createTestDirs();
    await mkdir(source, { recursive: true });
    await writeFile(resolve(source, "main.js"), "original");
    const another = resolve(root, "another-shard");
    await stageE2EAppOutput(source, destination);
    await stageE2EAppOutput(source, another);
    await writeFile(resolve(destination, "main.js"), "case-specific");
    expect(await readFile(resolve(source, "main.js"), "utf8")).toBe("original");
    expect(await readFile(resolve(another, "main.js"), "utf8")).toBe("original");
  });
});
