import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BotsRepo } from "../src/bots/repo.js";
import { setDataBaseDir } from "../src/paths.js";

describe("BotsRepo", () => {
  let tempDir: string | null = null;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "zcode-bots-repo-"));
    setDataBaseDir(tempDir);
  });

  afterEach(() => {
    setDataBaseDir(null);
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("reads legacy bot-state.json but writes bot-state.v3.json", async () => {
    const dataDir = join(tempDir!, ".zcode", "v2");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      join(dataDir, "bot-state.json"),
      `${JSON.stringify({
        version: 2,
        bots: {
          "feishu-1": {
            botId: "feishu-1",
            workspacePath: "/tmp/workspace",
            mode: "draft",
            activeTaskId: null,
            draftOptions: {
              provider: "glm",
              model: "custom:old-provider:deepseek-v4-flash",
            },
            updatedAt: 1,
          },
        },
      })}\n`,
    );

    const repo = new BotsRepo();

    await expect(repo.readState()).resolves.toMatchObject({
      bots: {
        "feishu-1": {
          draftOptions: {
            modelSelection: {
              providerId: "old-provider",
              modelId: "deepseek-v4-flash",
            },
          },
        },
      },
    });

    await repo.writeState({ version: 3, bots: {} });

    expect(existsSync(join(dataDir, "bot-state.json"))).toBe(true);
    expect(existsSync(join(dataDir, "bot-state.v3.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(dataDir, "bot-state.json"), "utf-8"))).toMatchObject({
      bots: {
        "feishu-1": {
          draftOptions: {
            model: "custom:old-provider:deepseek-v4-flash",
          },
        },
      },
    });
  });
});
