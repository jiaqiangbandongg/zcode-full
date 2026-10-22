import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { projectStorage } from "#src/project-storage/index.js";
import { createRemoteProjectService } from "#src/remote-projects/index.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

it("projects the manager upgrade target with the runtime state", async () => {
  const db = new DatabaseSync(":memory:");
  const directory = await mkdtemp(join(tmpdir(), "remote-project-state-test-"));
  cleanups.push(
    () => db.close(),
    () => rm(directory, { recursive: true, force: true }),
  );
  db.exec("PRAGMA foreign_keys=ON");
  await projectStorage.migrate(db, { backupDirectories: [directory] });
  // 投影曾丢掉 upgradeTarget，桌面端过旧时详情入口只能回退成“更新远端”。
  const service = createRemoteProjectService({
    database: async () => db,
    readConnectionStates: async () =>
      new Map([
        [
          "source",
          {
            connectionStatus: "offline" as const,
            lastConnectionStatus: "needs-upgrade",
            upgradeTarget: "controller" as const,
          },
        ],
      ]),
  });
  await service.saveHost({
    id: "source",
    target: { kind: "ssh", host: "example.test", username: "user" },
  });
  expect((await service.readDirectory()).hosts[0]).toMatchObject({
    lastConnectionStatus: "needs-upgrade",
    upgradeTarget: "controller",
  });
});
