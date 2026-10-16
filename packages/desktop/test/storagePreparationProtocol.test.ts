import { PassThrough } from "node:stream";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { prepareProtocolStartupStorage } from "../../../apps/zcode-cli/packages/bootstrap/src/zcode-protocol/storage-startup.js";

it("waits for path observation before opening storage and exits without business startup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-storage-only-"));
  const input = new PassThrough();
  const output = new PassThrough();
  const frames: Array<{ method: string; params: Record<string, unknown> }> = [];
  output.on("data", (chunk) => {
    const frame = JSON.parse(String(chunk));
    frames.push(frame);
    if (frame.method === "startup/storagePath") {
      expect(frames).toHaveLength(1);
      queueMicrotask(() =>
        input.write(JSON.stringify({ method: "startup/storagePathReady" }) + "\n"),
      );
    }
  });
  try {
    await prepareProtocolStartupStorage({ dbPath: join(dir, "db.sqlite"), input, output });
    expect(frames.find((frame) => frame.params.phase === "ready")?.params.migration).toMatchObject({
      lastAppliedMigrationId: null,
    });
    expect(frames.at(-1)?.method).toBe("startup/storagePrepared");
  } finally {
    input.destroy();
    output.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});

it("SILENTDB-06: Host reuse acknowledgement skips opening the already prepared storage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-storage-reuse-"));
  const path = join(dir, "not-created.sqlite");
  const input = new PassThrough();
  const output = new PassThrough();
  const frames: string[] = [];
  output.on("data", (chunk) => {
    const frame = JSON.parse(String(chunk));
    frames.push(frame.method);
    if (frame.method === "startup/storagePath")
      queueMicrotask(() =>
        input.write(JSON.stringify({ method: "startup/storagePathReady", reuse: true }) + "\n"),
      );
  });
  try {
    await prepareProtocolStartupStorage({ dbPath: path, input, output });
    expect(frames).toEqual(["startup/storagePath", "startup/storagePrepared"]);
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    input.destroy();
    output.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});
