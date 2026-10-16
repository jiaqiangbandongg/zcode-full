import { describe, expect, it } from "vitest";
import {
  controlRequestSchema,
  controlResponseSchema,
  releaseCatalogSchema,
  releaseManifestSchema,
  serverStatusSchema,
  createStoppedServerStatus,
} from "../src/contracts.js";

describe("R2 control contract", () => {
  it("rejects unknown lifecycle commands and accepts JSONL-safe requests", () => {
    expect(controlRequestSchema.safeParse({ id: "1", command: "status" }).success).toBe(true);
    expect(controlRequestSchema.safeParse({ id: "1", command: "kill-pid", pid: 4 }).success).toBe(
      false,
    );
    expect(
      controlRequestSchema.safeParse({ id: "1", command: "confirm-uninstall", confirmation: "DELETE" })
        .success,
    ).toBe(true);
  });

  it("keeps status output free of business payloads", () => {
    const parsed = serverStatusSchema.parse({
      state: "ready",
      pid: 42,
      port: 38123,
      host: "127.0.0.1",
      version: "3.8.0",
      generation: 1,
      serviceRegistered: false,
      runningTaskCount: 0,
      crashBudget: { windowStartedAt: 1, crashCount: 0, nextRestartDelayMs: 0, exhausted: false },
      updatedAt: 2,
    });
    expect(parsed).not.toHaveProperty("token");
    expect(controlResponseSchema.parse({ id: "1", ok: true, result: parsed }).ok).toBe(true);
  });

  it("rejects release versions that could escape the releases directory", () => {
    expect(releaseManifestSchema.safeParse({ version: "../escape", releaseDir: "/tmp/release" }).success).toBe(false);
    expect(releaseCatalogSchema.safeParse({
      schemaVersion: 1,
      releases: [{ version: "3.8.0/evil", target: "linux-x64", archiveUrl: "https://example.test/release.tar.gz", archiveSha256: "a".repeat(64) }],
    }).success).toBe(false);
  });

  it("builds a complete stopped snapshot for offline CLI fallbacks", () => {
    const status = createStoppedServerStatus("3.8.0", { serviceRegistered: true, now: 42 });
    expect(status).toEqual(expect.objectContaining({
      state: "stopped",
      pid: null,
      port: null,
      host: null,
      version: "3.8.0",
      generation: 0,
      startedAt: null,
      lastExitReason: null,
      serviceRegistered: true,
      runningTaskCount: 0,
      updatedAt: 42,
    }));
    expect(serverStatusSchema.parse(status)).toEqual(status);
  });
});
