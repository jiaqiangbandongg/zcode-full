import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { zcodeStorageStartupStateSchema } from "@zcode/shared";
import { openProtocolStartupStorage } from "../src/zcode-protocol/storage-startup.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
describe("迁移前的 stdio 启动控制帧", () => {
  it("真实 Writable 回调完成前不执行 SQL；无账号/Provider 参数也能准备数据库", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-storage-wire-"));
    dirs.push(dir);
    const dbPath = join(dir, "db.sqlite");
    const packets: unknown[] = [];
    let release!: () => void;
    let observed!: () => void;
    const barrier = new Promise<void>((resolve) => {
      observed = resolve;
    });
    const output = new Writable({
      write(chunk, _encoding, callback) {
        const packet = JSON.parse(String(chunk));
        packets.push(packet);
        if (
          packet.params.phase === "migrating" &&
          packet.params.migrationId === "0001_base_session_store"
        ) {
          release = () => callback();
          observed();
        } else callback();
      },
    });
    const diagnostics: unknown[] = [];
    const opening = openProtocolStartupStorage({
      dbPath,
      output,
      onProgress: (progress) => {
        diagnostics.push(progress);
      },
    });
    await barrier;
    const reader = new DatabaseSync(dbPath);
    try {
      expect(
        reader.prepare("SELECT 1 FROM sqlite_schema WHERE name='session'").get(),
      ).toBeUndefined();
    } finally {
      reader.close();
      release();
    }
    const store = await opening;
    try {
      const states = packets.map((packet) => {
        const envelope = packet as { method: string; params: unknown };
        expect(envelope.method).toBe("startup/storageState");
        return zcodeStorageStartupStateSchema.parse(envelope.params);
      });
      expect(states.at(-1)?.phase).toBe("ready");
      expect(new Set(states.map((s) => s.attemptId)).size).toBe(1);
      expect(states.map((s) => s.sequence)).toEqual(states.map((_, i) => i + 1));
      expect(JSON.stringify(packets)).not.toContain(dir);
      expect(diagnostics).toEqual(states);
    } finally {
      store.close();
    }
  });
});
