import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createE2EUICoverageCollector } from "./e2e/reporting/e2e-ui-coverage.js";

const previousCoverageEnv = process.env.ZCODE_E2E_COVERAGE;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  if (previousCoverageEnv === undefined) {
    delete process.env.ZCODE_E2E_COVERAGE;
  } else {
    process.env.ZCODE_E2E_COVERAGE = previousCoverageEnv;
  }
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("E2E UI coverage collector", () => {
  it("快照失败后 stop 仍会复位，after hook 重入不再访问已关闭 CDP", async () => {
    process.env.ZCODE_E2E_COVERAGE = "1";
    const artifactDir = await mkdtemp(join(tmpdir(), "zcode-e2e-ui-coverage-"));
    temporaryDirectories.push(artifactDir);
    const collector = createE2EUICoverageCollector({
      artifactDir,
      repoRoot: artifactDir,
    });
    const browser = {
      getPuppeteer: async () => {
        throw new Error("CDP already closed");
      },
    } as unknown as WebdriverIO.Browser;

    collector.prepare();
    collector.start(browser);

    await expect(collector.stop()).rejects.toThrow("CDP already closed");
    await expect(collector.stop()).resolves.toBeUndefined();
  });
});
