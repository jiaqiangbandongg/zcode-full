import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildServerRemoteWorkspaceIdentity } from "@zcode/shared";
import { getWorkspaceHash } from "#src/paths.js";
import {
  SourceServerWorkspaceAliasRepo,
  type SourceServerWorkspaceAliasRepoOptions,
} from "#src/session/sourceServerWorkspaceAliasRepo.js";
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";
import { seedTaskIndex } from "./helpers/taskIndexFixture.js";
import { createSourceServerWorkspaceService } from "#src/source-server-workspace/sourceServerWorkspaceService.js";
import { SourceServerWorkspaceIdentityMapper } from "#src/source-server-workspace/sourceServerWorkspaceIdentityChannelServer.js";

const workspacePath = "/srv/project";
const keyA = "remote:ssh:host-a.example.com:22:user:/srv/project";
const keyB = "remote:ssh:host-b.example.com:22:user:/srv/project";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(options: SourceServerWorkspaceAliasRepoOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "zcode-alias-concurrent-"));
  roots.push(root);
  const taskDbPath = join(root, "tasks-index.sqlite");
  const index = new TaskIndexRepo(undefined, undefined, taskDbPath);
  await index.ensureReady();
  index.close();
  const repo = new SourceServerWorkspaceAliasRepo({
    taskDbPath,
    sessionDbPath: join(root, "missing.sqlite"),
    backupRoot: join(root, "backups"),
    ...options,
  });
  return { root, taskDbPath, repo };
}

async function seedVariants(taskDbPath: string) {
  const index = new TaskIndexRepo(undefined, undefined, taskDbPath);
  try {
    for (const [workspaceIdentity, taskId, updatedAt] of [
      [keyA, "task-a", 10],
      [keyB, "task-b", 20],
    ] as const) {
      await seedTaskIndex(index, {
        meta: {
          taskId,
          traceId: `trace-${taskId}`,
          title: taskId,
          workspacePath,
          workspaceIdentity,
          createdAt: 1,
          updatedAt,
          mode: "default",
          status: "completed",
        },
      });
    }
  } finally {
    index.close();
  }
}

async function writeConfig(root: string, key: string, name: string, value: string) {
  const directory = join(root, "sessions", getWorkspaceHash(workspacePath, key));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, name), value);
  return join(directory, name);
}

function readState(taskDbPath: string) {
  const db = new DatabaseSync(taskDbPath);
  try {
    return {
      alias: db
        .prepare("SELECT canonical_key FROM workspace_alias WHERE path = ?")
        .get(workspacePath),
      ledgers: db
        .prepare(
          "SELECT migration_id, canonical_key, status, phase FROM workspace_migration_ledger ORDER BY rowid",
        )
        .all(),
      tasks: db.prepare("SELECT workspace_key, task_id FROM tasks ORDER BY task_id").all(),
    };
  } finally {
    db.close();
  }
}

describe("Source Server canonical alias admission", () => {
  it.each([workspacePath, ` ${workspacePath} `])(
    "keeps concurrent first responses, persisted alias and mapper consistent for %s",
    async (secondPath) => {
      const { taskDbPath, repo } = await setup();
      const mapper = new SourceServerWorkspaceIdentityMapper();
      const stableIdentity = buildServerRemoteWorkspaceIdentity({
        serverId: "server-1",
        workspacePath,
      });
      const service = createSourceServerWorkspaceService(repo, {
        onResolved: ({ canonicalWorkspaceKey }) => {
          mapper.register({ stableIdentity, canonicalIdentity: canonicalWorkspaceKey });
        },
      });
      const responses = await Promise.all([
        service.resolveWorkspace({ workspacePath, legacyRouteHint: keyA }),
        service.resolveWorkspace({ workspacePath: secondPath, legacyRouteHint: keyB }),
      ]);

      expect(responses.map((response) => response.canonicalWorkspaceKey)).toEqual([keyA, keyA]);
      expect(readState(taskDbPath).alias).toEqual({ canonical_key: keyA });
      expect(mapper.mapIncoming(stableIdentity)).toBe(keyA);
      expect(mapper.mapOutgoing(keyA)).toBe(stableIdentity);
    },
  );

  it("merges concurrent variants and config directories once", async () => {
    const { root, taskDbPath, repo } = await setup();
    await seedVariants(taskDbPath);
    await writeConfig(root, keyA, "a.json", "source config");
    await writeConfig(root, keyB, "b.json", "canonical config");

    const results = await Promise.allSettled([
      repo.resolveCanonicalWorkspaceKey({ workspacePath, legacyRouteHint: keyA }),
      repo.resolveCanonicalWorkspaceKey({ workspacePath, legacyRouteHint: keyB }),
    ]);

    expect(results).toEqual([
      {
        status: "fulfilled",
        value: { canonicalKey: keyB, mergedKeys: [keyA], migrationId: expect.any(String) },
      },
      { status: "fulfilled", value: { canonicalKey: keyB, mergedKeys: [] } },
    ]);
    expect(readState(taskDbPath)).toEqual({
      alias: { canonical_key: keyB },
      ledgers: [
        {
          migration_id: expect.any(String),
          canonical_key: keyB,
          status: "completed",
          phase: "completed",
        },
      ],
      tasks: [
        { workspace_key: keyB, task_id: "task-a" },
        { workspace_key: keyB, task_id: "task-b" },
      ],
    });
    const canonicalDirectory = join(root, "sessions", getWorkspaceHash(workspacePath, keyB));
    expect(await readFile(join(canonicalDirectory, "a.json"), "utf8")).toBe("source config");
    expect(await readFile(join(canonicalDirectory, "b.json"), "utf8")).toBe("canonical config");
  });

  it.each([workspacePath, ` ${workspacePath} `])(
    "releases a failed migration and lets retry resume without reentering admission for %s",
    async (retryPath) => {
      let failPreflight = true;
      const { taskDbPath, repo } = await setup({
        afterPhaseCommitted: (phase) => {
          if (phase === "preflight" && failPreflight) {
            failPreflight = false;
            throw new Error("interrupted before backup");
          }
        },
      });
      await seedVariants(taskDbPath);
      await expect(repo.resolveCanonicalWorkspaceKey({ workspacePath })).rejects.toThrow(
        "interrupted before backup",
      );
      const [failed] = readState(taskDbPath).ledgers;
      expect(failed).toMatchObject({ status: "failed", phase: "preflight" });

      const results = await Promise.allSettled([
        repo.retryFailedWorkspace(retryPath),
        repo.resolveCanonicalWorkspaceKey({ workspacePath }),
      ]);
      expect(results).toEqual([
        {
          status: "fulfilled",
          value: { canonicalKey: keyB, mergedKeys: [keyA], migrationId: failed?.migration_id },
        },
        { status: "fulfilled", value: { canonicalKey: keyB, mergedKeys: [] } },
      ]);
      expect(readState(taskDbPath).ledgers).toEqual([
        {
          migration_id: failed?.migration_id,
          canonical_key: keyB,
          status: "completed",
          phase: "completed",
        },
      ]);
    },
  );

  it.each([workspacePath, ` ${workspacePath} `])(
    "queues abandon before resolve after a failed retry for %s",
    async (abandonPath) => {
      const { root, taskDbPath, repo } = await setup();
      await seedVariants(taskDbPath);
      const sourceConfig = await writeConfig(root, keyA, "settings.json", "source");
      await writeConfig(root, keyB, "settings.json", "canonical");
      await expect(repo.resolveCanonicalWorkspaceKey({ workspacePath })).rejects.toThrow(
        "config conflict",
      );
      await expect(repo.retryFailedWorkspace(workspacePath)).rejects.toThrow("config conflict");

      const results = await Promise.allSettled([
        repo.abandonFailedWorkspace(abandonPath),
        repo.resolveCanonicalWorkspaceKey({ workspacePath }),
      ]);
      expect(results).toEqual([
        { status: "fulfilled", value: undefined },
        { status: "fulfilled", value: { canonicalKey: keyB, mergedKeys: [] } },
      ]);
      expect(readState(taskDbPath).ledgers).toEqual([
        { migration_id: expect.any(String), canonical_key: keyB, status: "abandoned", phase: null },
      ]);

      await rm(sourceConfig);
      await expect(repo.retryFailedWorkspace(workspacePath)).resolves.toMatchObject({
        canonicalKey: keyB,
        mergedKeys: [keyA],
      });
      await expect(repo.resolveCanonicalWorkspaceKey({ workspacePath })).resolves.toEqual({
        canonicalKey: keyB,
        mergedKeys: [],
      });
    },
  );

  it("lets another path resolve while a migration is waiting for IO", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const { taskDbPath, repo } = await setup({
      afterPhaseCommitted: async (phase) => {
        if (phase !== "preflight") return;
        entered.resolve();
        await release.promise;
      },
    });
    await seedVariants(taskDbPath);
    const migration = repo.resolveCanonicalWorkspaceKey({ workspacePath });
    const otherPath = "/srv/other";
    const otherHint = "remote:ssh:host-a.example.com:22:user:/srv/other";
    try {
      await entered.promise;
      await expect(
        repo.resolveCanonicalWorkspaceKey({ workspacePath: otherPath, legacyRouteHint: otherHint }),
      ).resolves.toEqual({ canonicalKey: otherHint, mergedKeys: [] });
    } finally {
      release.resolve();
      await migration;
    }
    expect(readState(taskDbPath).alias).toEqual({ canonical_key: keyB });
  });
});
