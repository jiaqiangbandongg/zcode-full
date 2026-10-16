import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setDataBaseDir } from "../src/paths.js";
import * as f from "./botsService.fixtures.js";
import { startFeishuBotWebSocket } from "../src/bots/providers/feishuProvider.js";

vi.mock("../src/bots/providers/feishuProvider.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/bots/providers/feishuProvider.js")>();
  return {
    ...actual,
    startFeishuBotWebSocket: vi.fn(async () => ({ close: vi.fn() })),
  };
});

let tempDir: string | null = null;

afterEach(() => {
  setDataBaseDir(null);
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

function useTempDataDir() {
  tempDir = mkdtempSync(join(tmpdir(), "zcode-bots-feishu-runtime-lock-"));
  setDataBaseDir(tempDir);
}

describe("botsService Feishu runtime lock", () => {
  it("does not start a second local WebSocket client for the same Feishu bot", async () => {
    useTempDataDir();
    const serviceA = f.createBotsService({
      credentialService: f.createCredentialService({ "feishu-secret": "secret" }),
      legacyTaskService: f.createLegacyTaskService(),
      repo: f.createMemoryRepo(f.feishuConfig) as never,
    });

    await vi.waitFor(async () => {
      const runtime = (await serviceA.getStatus()).botRuntime[0];
      expect(runtime).toMatchObject({
        status: "connected",
        message: "Feishu WebSocket is running.",
      });
    });

    const serviceB = f.createBotsService({
      credentialService: f.createCredentialService({ "feishu-secret": "secret" }),
      legacyTaskService: f.createLegacyTaskService(),
      repo: f.createMemoryRepo(f.feishuConfig) as never,
    });

    await vi.waitFor(async () => {
      const runtime = (await serviceB.getStatus()).botRuntime[0];
      expect(runtime).toMatchObject({
        status: "idle",
        message: "Feishu WebSocket is handled by another ZCode window.",
      });
    });

    expect(startFeishuBotWebSocket).toHaveBeenCalledTimes(1);

    serviceB.disposeAll();
    serviceA.disposeAll();
  });
});
