import { describe, expect, it } from "vitest";
import {
  ZCODE_COMPATIBILITY_MANIFEST,
  sourceServerUpdateTargetSchema,
  getSourceServerUpdateTarget,
  isSameSourceServerUpdateTarget,
  compatibilityManifestSchema,
  connectionProfileSchema,
  evaluateSourceServerCompatibility,
  serverRemoteInfoSchema,
  serverRemoteInfoOutputSchema,
  serverRemoteAnonymousInfoSchema,
  sourceServerRecordSchema,
  sourceServerManagementSnapshotSchema,
  sourceServerManagementSnapshotRequestSchema,
  SOURCE_SERVER_UPDATE_RUNNING_TASKS_ERROR_CODE,
  isPublicZCodeErrorCode,
  sourceServerConnectionStateSnapshotSchema,
  sourceServerOperationLogSchema,
  sourceServerInstallProgressSchema,
  sourceServerReleaseDescriptorSchema,
} from "../src/index.js";

const profileId = "17ef20b3-622d-4a53-98c1-0cdff29f3e6d";
const sourceServerId = "3cd4f9da-cd79-426c-9d70-75f36e9f6a87";

describe("R3 Source Server contracts", () => {
  it("negotiates optional virtualProjects without changing the legacy wire version", () => {
    const legacy = {
      serverId: sourceServerId,
      name: "Server",
      version: "3",
      protocolVersion: 1,
      authRequired: false,
      workspaces: [],
      capabilities: { desktopContinuous: true, websocketRpc: true },
    };
    expect(serverRemoteInfoSchema.parse(legacy).capabilities).not.toHaveProperty("virtualProjects");
    const modern = { ...legacy, capabilities: { ...legacy.capabilities, virtualProjects: true } };
    expect(serverRemoteInfoOutputSchema.parse(modern).capabilities.virtualProjects).toBe(true);
    expect(serverRemoteInfoSchema.parse(modern).capabilities.virtualProjects).toBe(true);
  });
  it("validates read-only install preview and isolated running task projections", () => {
    const base = { profileId, state: "needs-install", updatedAt: 1 };
    const installPreview = {
      version: "3.12.2",
      installPath: "/home/dev/.zcode/server",
      sizeBytes: 4194304,
    };
    const runningTasks = [
      { sessionId: "task", workspacePath: "/repo", workspaceIdentity: "source:/repo" },
    ];
    expect(
      sourceServerConnectionStateSnapshotSchema.parse({ ...base, installPreview, runningTasks }),
    ).toMatchObject({ installPreview, runningTasks });
    expect(
      sourceServerConnectionStateSnapshotSchema.safeParse({
        ...base,
        installPreview: { ...installPreview, sizeBytes: -1 },
      }).success,
    ).toBe(false);
    expect(
      sourceServerConnectionStateSnapshotSchema.safeParse({
        ...base,
        runningTasks: [{ sessionId: "task" }],
      }).success,
    ).toBe(false);
  });
  it("统计未取得时使用显式状态，不允许附带伪造计数或未知状态", () => {
    expect(sourceServerManagementSnapshotRequestSchema.safeParse({}).success).toBe(true);
    expect(
      sourceServerManagementSnapshotRequestSchema.safeParse({ refreshMigrationCounts: true })
        .success,
    ).toBe(true);
    expect(
      sourceServerManagementSnapshotRequestSchema.safeParse({ refreshMigrationCounts: "true" })
        .success,
    ).toBe(false);
    expect(sourceServerManagementSnapshotRequestSchema.safeParse({ extra: true }).success).toBe(
      false,
    );
    const schema = sourceServerManagementSnapshotSchema.shape.migrationCounts.element;
    for (const status of ["loading", "unavailable", "requires-connection"]) {
      expect(schema.safeParse({ sourceServerId, status }).success).toBe(true);
      expect(schema.safeParse({ sourceServerId, status, failedPathCount: 0 }).success).toBe(false);
    }
    expect(
      schema.safeParse({
        sourceServerId,
        status: "available",
        failedPathCount: 0,
        abandonedPathCount: 2,
      }).success,
    ).toBe(true);
    expect(schema.safeParse({ sourceServerId, status: "unknown" }).success).toBe(false);
  });
  it("accepts install progress without allowing readiness or arbitrary payloads", () => {
    for (const phase of ["verify-archive", "extract", "verify", "restart"]) {
      expect(
        sourceServerInstallProgressSchema.safeParse({
          type: "source-server-install-progress",
          phase,
        }).success,
      ).toBe(true);
    }
    for (const value of [
      { type: "source-server-install-progress", phase: "ready" },
      { type: "source-server-install-progress", phase: "verify", progress: 100 },
      { phase: "verify" },
      { applied: true },
    ])
      expect(sourceServerInstallProgressSchema.safeParse(value).success).toBe(false);
  });
  it("keeps Source update, migration and bind errors in one public registry", () => {
    expect(SOURCE_SERVER_UPDATE_RUNNING_TASKS_ERROR_CODE).toBe(
      "source-server-update-running-tasks",
    );
    expect(
      [
        SOURCE_SERVER_UPDATE_RUNNING_TASKS_ERROR_CODE,
        "source-server-upgrade-required",
        "workspace-task-identity-conflict",
        "workspace-config-file-conflict",
        "remote-bind-canceled",
        "remote-workspace-bind-session-missing",
        "remote-workspace-directory-unavailable",
      ].every(isPublicZCodeErrorCode),
    ).toBe(true);
    expect(isPublicZCodeErrorCode("internal-stack-trace")).toBe(false);
  });

  it("rejects unregistered error codes in Source management state", () => {
    const base = {
      profileId,
      state: "failed" as const,
      updatedAt: 1,
    };
    expect(
      sourceServerConnectionStateSnapshotSchema.safeParse({
        ...base,
        errorCode: "source-server-private-debug",
      }).success,
    ).toBe(false);
    expect(
      sourceServerConnectionStateSnapshotSchema.safeParse({
        ...base,
        errorCode: "source-server-upgrade-required",
      }).success,
    ).toBe(true);
  });

  it("严格校验 Source Server 更新进度日志", () => {
    expect(
      sourceServerOperationLogSchema.parse({
        profileId,
        operation: "update",
        phase: "upload",
        level: "info",
        message: "archive",
        progress: 0.5,
        timestamp: 1,
      }),
    ).toMatchObject({ phase: "upload", progress: 0.5 });
    expect(
      sourceServerOperationLogSchema.safeParse({
        profileId,
        operation: "update",
        phase: "upload",
        level: "info",
        message: "archive",
        progress: 1.1,
        timestamp: 1,
      }).success,
    ).toBe(false);
  });

  it.each([
    {
      transport: "ssh",
      target: {
        kind: "ssh",
        host: "example.com",
        port: 22,
        username: "alice",
        passwordCredentialKey: `connection-profile:${profileId}:password`,
      },
    },
    {
      transport: "wsl",
      target: { kind: "wsl", distro: "Ubuntu-24.04", user: "alice" },
    },
    {
      transport: "docker",
      target: { kind: "docker", container: "zcode-dev" },
    },
  ] as const)("accepts a strict $transport Connection Profile", ({ transport, target }) => {
    expect(
      connectionProfileSchema.parse({
        profileId,
        transport,
        target,
        sourceServerId,
        createdAt: 1,
      }),
    ).toMatchObject({ transport, target, lifecycleState: "active" });
  });

  it("defaults old Source/Profile records to installed and active", () => {
    expect(sourceServerRecordSchema.parse({ sourceServerId, displayName: "server" })).toMatchObject(
      { installState: "installed", declaredWorkspaces: [] },
    );
    expect(
      connectionProfileSchema.parse({
        profileId,
        transport: "docker",
        target: { kind: "docker", container: "demo" },
        createdAt: 1,
      }),
    ).toMatchObject({ lifecycleState: "active" });
  });

  it("accepts and strictly validates device-level remote workspace records", () => {
    const parsed = sourceServerRecordSchema.parse({
      sourceServerId,
      displayName: "server",
      declaredWorkspaces: [
        {
          workspacePath: "/srv/project",
          workspaceIdentity: `remote:server:${sourceServerId}:/srv/project`,
          label: "project",
        },
      ],
    });
    expect(parsed.declaredWorkspaces).toEqual([
      {
        workspacePath: "/srv/project",
        workspaceIdentity: `remote:server:${sourceServerId}:/srv/project`,
        label: "project",
      },
    ]);
    expect(
      sourceServerRecordSchema.safeParse({
        sourceServerId,
        displayName: "server",
        declaredWorkspaces: [{ workspacePath: "/srv/project", unknown: true }],
      }).success,
    ).toBe(false);
  });

  it("rejects transport/target mismatches, inline secrets and unknown fields", () => {
    expect(
      connectionProfileSchema.safeParse({
        profileId,
        transport: "docker",
        target: { kind: "ssh", host: "example.com", username: "alice" },
        createdAt: 1,
      }).success,
    ).toBe(false);
    expect(
      connectionProfileSchema.safeParse({
        profileId,
        transport: "ssh",
        target: {
          kind: "ssh",
          host: "example.com",
          username: "alice",
          password: "secret",
        },
        createdAt: 1,
      }).success,
    ).toBe(false);
    expect(
      connectionProfileSchema.safeParse({
        profileId,
        transport: "docker",
        target: { kind: "docker", container: "zcode-dev" },
        createdAt: 1,
        unexpected: true,
      }).success,
    ).toBe(false);
  });

  it("validates Source Server records strictly", () => {
    expect(
      sourceServerRecordSchema.parse({
        sourceServerId,
        displayName: "devbox · alice",
        osUser: "alice",
        hostname: "devbox",
        preferredProfileId: profileId,
      }),
    ).toMatchObject({ sourceServerId, displayName: "devbox · alice" });
    expect(
      sourceServerRecordSchema.safeParse({
        sourceServerId,
        displayName: "devbox · alice",
        route: "ssh://example.com",
      }).success,
    ).toBe(false);
  });

  it("validates the embedded compatibility manifest", () => {
    expect(compatibilityManifestSchema.parse(ZCODE_COMPATIBILITY_MANIFEST)).toEqual(
      ZCODE_COMPATIBILITY_MANIFEST,
    );
    expect(
      compatibilityManifestSchema.safeParse({
        ...ZCODE_COMPATIBILITY_MANIFEST,
        unknown: true,
      }).success,
    ).toBe(false);
  });

  it("validates an independent content-addressed Source Server release descriptor", () => {
    const descriptor = sourceServerReleaseDescriptorSchema.parse({
      schemaVersion: 1,
      version: "3.8.1",
      archives: [
        {
          target: "linux-x64",
          version: "3.8.1",
          fileName: "zcode-server-linux-x64.tar.gz",
          sha256: "a".repeat(64),
          sizeBytes: 1024,
          urls: ["zcode-server-linux-x64.tar.gz"],
        },
      ],
    });

    expect(descriptor.archives[0]).toMatchObject({
      target: "linux-x64",
      sha256: "a".repeat(64),
      sizeBytes: 1024,
    });
    expect(() =>
      sourceServerReleaseDescriptorSchema.parse({
        ...descriptor,
        archives: [descriptor.archives[0], descriptor.archives[0]],
      }),
    ).toThrow(/duplicate Source Server release target/i);
  });

  it("keeps client server-info parsing forward compatible while server output stays strict", () => {
    const info = {
      serverId: sourceServerId,
      version: "3.8.0",
      protocolVersion: 1,
      authRequired: true,
      workspaces: [],
      compatibility: {
        schemaVersion: 1,
        productVersion: "3.8.0",
        minCompatibleVersion: "3.8.0",
      },
      migration: { failedPathCount: 2 },
      identity: { osUser: "alice", hostname: "devbox" },
      capabilities: { desktopContinuous: true, websocketRpc: true },
    };
    expect(serverRemoteInfoSchema.parse(info)).toEqual(info);
    expect(
      serverRemoteInfoSchema.parse({
        ...info,
        futureField: true,
        migration: { failedPathCount: 2, futureMigrationField: "ignored" },
      }),
    ).toEqual(info);
    expect(serverRemoteInfoOutputSchema.safeParse({ ...info, futureField: true }).success).toBe(
      false,
    );
    expect(
      serverRemoteAnonymousInfoSchema.parse({
        version: "3.7.0",
        protocolVersion: 1,
        authRequired: true,
        compatibility: info.compatibility,
        futureField: true,
      }),
    ).toEqual({
      version: "3.7.0",
      protocolVersion: 1,
      authRequired: true,
      compatibility: info.compatibility,
    });
  });

  it("lets the newer endpoint manifest decide whether the older endpoint is compatible", () => {
    expect(
      evaluateSourceServerCompatibility(
        {
          schemaVersion: 1,
          productVersion: "3.9.0",
          minCompatibleVersion: "3.8.0",
        },
        {
          schemaVersion: 1,
          productVersion: "3.8.2",
          minCompatibleVersion: "3.8.0",
        },
      ),
    ).toMatchObject({
      compatible: true,
      newerEndpoint: "controller",
      updateAvailable: true,
    });
    expect(
      evaluateSourceServerCompatibility(
        {
          schemaVersion: 1,
          productVersion: "4.0.0",
          minCompatibleVersion: "3.9.0",
        },
        {
          schemaVersion: 1,
          productVersion: "3.8.9",
          minCompatibleVersion: "3.8.0",
        },
      ),
    ).toMatchObject({ compatible: false, upgradeTarget: "server" });
    expect(
      evaluateSourceServerCompatibility(
        {
          schemaVersion: 1,
          productVersion: "3.8.0",
          minCompatibleVersion: "3.8.0",
        },
        {
          schemaVersion: 1,
          productVersion: "4.0.0",
          minCompatibleVersion: "3.9.0",
        },
      ),
    ).toMatchObject({ compatible: false, upgradeTarget: "controller" });
  });
});

it("升级身份只允许规范化非敏感字段，WSL 必须已解析", () => {
  const ssh = {
    kind: "ssh",
    host: " Example.com ",
    username: "dev",
    password: "secret",
    privateKeyPath: "/tmp/key",
  } as const;
  expect(getSourceServerUpdateTarget(ssh)).toEqual({
    kind: "ssh",
    host: "example.com",
    port: 22,
    username: "dev",
  });
  expect(
    isSameSourceServerUpdateTarget(ssh, {
      kind: "ssh",
      host: "example.com",
      port: 22,
      username: "dev",
    }),
  ).toBe(true);
  expect(sourceServerUpdateTargetSchema.safeParse({ kind: "wsl", distro: "Ubuntu" }).success).toBe(
    false,
  );
  expect(
    sourceServerUpdateTargetSchema.safeParse({ kind: "wsl", distro: "Ubuntu", user: "" }).success,
  ).toBe(false);
  expect(
    sourceServerUpdateTargetSchema.safeParse({ kind: "docker", container: "a", password: "secret" })
      .success,
  ).toBe(false);
  expect(sourceServerUpdateTargetSchema.safeParse(ssh).success).toBe(false);
});

it("尚未解析的 WSL Profile 不匹配实际升级身份", () => {
  expect(
    isSameSourceServerUpdateTarget({ kind: "wsl" }, { kind: "wsl", distro: "Ubuntu", user: "dev" }),
  ).toBe(false);
});
