import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { projectStorage } from "#src/project-storage/index.js";
import { createRemoteProjectService } from "#src/remote-projects/index.js";
import type { RemoteProjectCache } from "#src/remote-projects/contract.js";
const databases: DatabaseSync[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function fixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec("PRAGMA foreign_keys=ON");
  const directory = await mkdtemp(join(tmpdir(), "remote-project-test-"));
  directories.push(directory);
  await projectStorage.migrate(db, { backupDirectories: [directory] });
  const afterChange = vi.fn();
  const service = createRemoteProjectService({
    database: async () => db,
    afterChange,
    now: () => 100,
  });
  const target = { kind: "ssh" as const, host: "example.test", username: "user" };
  await service.saveHost({ id: "source", target });
  const project: RemoteProjectCache = {
    projectId: "p",
    name: "Remote",
    roots: [{ rootPath: "/repo", position: 0, isPrimary: true }],
  };
  return { db, service, afterChange, target, project };
}

it("URL 首次握手固化稳定身份，下一次身份变化不能迁移入口", async () => {
  const { service, project } = await fixture();
  const host = await service.saveHost({
    id: "remote:server:example-test",
    target: {
      kind: "server",
      url: "https://example.test",
      tokenCredentialKey: "token-key",
    },
  });
  const entry = await service.addEntry({ hostId: host.id, project });
  const bound = await service.bindHost({
    id: host.id,
    membershipId: host.membershipId,
    resolvedId: "remote:server:stable",
  });
  expect(bound?.target).toMatchObject({ serverId: "stable", tokenCredentialKey: "token-key" });
  expect((await service.readDirectory()).entries.find((item) => item.id === entry.id)?.hostId).toBe(
    "remote:server:stable",
  );
  await expect(
    service.bindHost({
      id: bound!.id,
      membershipId: bound!.membershipId,
      resolvedId: "remote:server:other",
    }),
  ).rejects.toThrow("remote-project.source-identity-changed");
});

it("URL admission 复用凭据服务，保留连接不重建成员，迟到握手不能复活入口", async () => {
  const { service } = await fixture();
  const { prepareRemoteServerConnection } = await import("#src/remote-projects/index.js");
  const secrets = new Map<string, string>();
  const credentials = {
    load: vi.fn(async (key: string) => secrets.get(key) ?? null),
    save: vi.fn(async (key: string, value: string) => {
      secrets.set(key, value);
    }),
  };
  const input = { kind: "server" as const, url: "https://example.test", token: "secret" };
  const admission = await prepareRemoteServerConnection({
    service,
    credentials,
    target: input,
    intent: "add",
  });
  expect(admission.target.token).toBe("secret");
  const saved = (await service.readDirectory()).hosts.find((host) => host.kind === "server")!;
  expect(JSON.stringify(saved)).not.toContain("secret");
  await admission.commit("stable");
  const retained = await prepareRemoteServerConnection({
    service,
    credentials,
    target: { ...input, token: undefined, serverId: "stable" },
    intent: "retain",
  });
  expect(retained.target.token).toBe("secret");
  await service.removeHost("remote:server:stable");
  await expect(retained.commit("stable")).rejects.toThrow("remote-project.host-removed");
  await expect(
    prepareRemoteServerConnection({
      service,
      credentials,
      target: retained.target,
      intent: "retain",
    }),
  ).rejects.toThrow("remote-project.host-removed");
  expect((await service.readDirectory()).hosts.some((host) => host.kind === "server")).toBe(false);
});
