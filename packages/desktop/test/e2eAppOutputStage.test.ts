import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

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
  it("creates a recursive hard-link snapshot", async () => {
    const { destination, source } = await createTestDirs();
    await mkdir(resolve(source, "renderer"), { recursive: true });
    await writeFile(resolve(source, "renderer", "main.js"), "main");

    await stageE2EAppOutput(source, destination);

    expect(await readFile(resolve(destination, "renderer", "main.js"), "utf8")).toBe("main");
    const [sourceStat, destinationStat] = await Promise.all([
      stat(resolve(source, "renderer", "main.js")),
      stat(resolve(destination, "renderer", "main.js")),
    ]);
    expect(destinationStat.ino).toBe(sourceStat.ino);
  });

  it("falls back to copying when the filesystem rejects links", async () => {
    const { destination, source } = await createTestDirs();
    await mkdir(source, { recursive: true });
    await writeFile(resolve(source, "main.js"), "main");
    const linkFile = vi.fn(async () => {
      throw Object.assign(new Error("cross-device link"), { code: "EXDEV" });
    });

    await stageE2EAppOutput(source, destination, { linkFile });

    expect(linkFile).toHaveBeenCalledOnce();
    expect(await readFile(resolve(destination, "main.js"), "utf8")).toBe("main");
  });
});
