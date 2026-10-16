import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { SqliteSessionStore } from "../src/storage/session-store/sqlite-session-store.js";

describe("迁移进程在提交边界崩溃", () => {
  it.each(["committing", "ready"] as const)(
    "%s 时终止：以磁盘账本决定重试，不依赖完成通知",
    async (stopAt) => {
      const root = await mkdtemp(join(tmpdir(), "zcode-migration-crash-"));
      const dbPath = join(root, "db.sqlite");
      const child = fork(
        new URL("./fixtures/session-migration-crash-process.ts", import.meta.url),
        {
          execArgv: ["--import", "tsx"],
          stdio: ["ignore", "ignore", "inherit", "ipc"],
        },
      );
      try {
        const barrier = new Promise<void>((resolve, reject) => {
          child.once("error", reject);
          child.once("exit", () => reject(new Error("child exited before barrier")));
          child.on("message", (message: { type?: string }) => {
            if (message.type === "listening") child.send({ dbPath, stopAt });
            if (message.type === "barrier") resolve();
          });
        });
        await barrier;
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
        const db = new DatabaseSync(dbPath);
        try {
          const ledgerExists = Boolean(
            db.prepare("SELECT 1 FROM sqlite_schema WHERE name='schema_migration'").get(),
          );
          expect(ledgerExists).toBe(stopAt === "ready");
          const before = ledgerExists
            ? db.prepare("SELECT * FROM schema_migration ORDER BY id").all()
            : null;
          const stages: string[] = [];
          const store = await SqliteSessionStore.openStartup(
            { dbPath },
            {
              onProgress: async (s) => {
                stages.push(s.phase);
              },
            },
          );
          store.close();
          expect(stages.includes("migrating")).toBe(stopAt === "committing");
          if (before)
            expect(db.prepare("SELECT * FROM schema_migration ORDER BY id").all()).toEqual(before);
          expect(stages.at(-1)).toBe("ready");
        } finally {
          db.close();
        }
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit");
          child.kill("SIGKILL");
          await exited;
        }
        await rm(root, { recursive: true, force: true });
      }
    },
    15_000,
  );
});
