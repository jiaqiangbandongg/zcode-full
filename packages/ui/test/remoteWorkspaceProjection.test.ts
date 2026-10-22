import { describe, expect, it } from "vitest";
import type { SourceServerManagementSnapshot } from "@zcode/shared";
import { buildRemoteWorkspaceProjection } from "@/remote/remoteWorkspaceProjection.js";

function createSnapshot(): SourceServerManagementSnapshot {
  return {
    generation: 3,
    servers: [
      {
        sourceServerId: "11111111-1111-4111-8111-111111111111",
        displayName: "Dev Linux",
        osUser: "dev",
        installState: "installed",
        declaredWorkspaces: [],
      },
    ],
    profiles: [
      {
        profileId: "22222222-2222-4222-8222-222222222222",
        sourceServerId: "11111111-1111-4111-8111-111111111111",
        transport: "ssh",
        target: { kind: "ssh", host: "linux-amd64-dev", username: "dev" },
        createdAt: 1,
        lifecycleState: "active",
      },
    ],
    states: [
      {
        profileId: "22222222-2222-4222-8222-222222222222",
        sourceServerId: "11111111-1111-4111-8111-111111111111",
        state: "online",
        updatedAt: 3,
      },
    ],
    workspaceHistory: [
      {
        sourceServerId: "11111111-1111-4111-8111-111111111111",
        profileId: "22222222-2222-4222-8222-222222222222",
        workspacePath: "/workspace/project",
        workspaceIdentity: "remote:server:11111111-1111-4111-8111-111111111111:/workspace/project",
        lastOpenedAt: 2,
      },
    ],
    failedPathCount: 0,
    abandonedPathCount: 0,
    migrationCounts: [],
  };
}

describe("RemoteWorkspaceProjection", () => {
  it("joins device status, project history and open attachments without treating online as ready", () => {
    const projection = buildRemoteWorkspaceProjection({
      managementSnapshot: createSnapshot(),
      tabs: [
        {
          id: "conversation",
          kind: "workspace",
          workspacePath: "/workspace/conversation",
          workspaceIdentity:
            "remote:server:11111111-1111-4111-8111-111111111111:/workspace/conversation",
          workspacePurpose: "conversation",
          label: "conversation",
          remoteSessionId: "session-conversation",
        },
        {
          id: "project",
          kind: "workspace",
          workspacePath: "/workspace/project",
          workspaceIdentity:
            "remote:server:11111111-1111-4111-8111-111111111111:/workspace/project",
          workspacePurpose: "project",
          label: "project",
        },
      ],
      attachments: [
        {
          remoteSessionId: "session-conversation",
          workspaceKey:
            "remote:server:11111111-1111-4111-8111-111111111111:/workspace/conversation",
          sourceServerId: "11111111-1111-4111-8111-111111111111",
          state: "ready",
        },
      ],
    });

    expect(projection.devices).toEqual([
      expect.objectContaining({
        sourceServerId: "11111111-1111-4111-8111-111111111111",
        aggregatedStatus: "online",
      }),
    ]);
    expect(projection.openWorkspaces).toEqual([
      expect.objectContaining({
        workspacePath: "/workspace/conversation",
        purpose: "conversation",
        attachmentState: "ready",
        sourceServerId: "11111111-1111-4111-8111-111111111111",
      }),
      expect.objectContaining({
        workspacePath: "/workspace/project",
        purpose: "project",
        attachmentState: "disconnected",
      }),
    ]);
    expect(projection.projectHistory).toEqual([
      expect.objectContaining({ workspacePath: "/workspace/project" }),
    ]);
  });

  it("keeps the same path with different identities isolated", () => {
    const snapshot = createSnapshot();
    snapshot.workspaceHistory = [
      ...snapshot.workspaceHistory,
      {
        sourceServerId: "11111111-1111-4111-8111-111111111111",
        profileId: "22222222-2222-4222-8222-222222222222",
        workspacePath: "/workspace/shared",
        workspaceIdentity: "remote:server:other:/workspace/shared",
        lastOpenedAt: 4,
      },
    ];
    const projection = buildRemoteWorkspaceProjection({
      managementSnapshot: snapshot,
      tabs: [
        {
          id: "remote-a",
          kind: "workspace",
          workspacePath: "/workspace/shared",
          workspaceIdentity: "remote:server:source-a:/workspace/shared",
          workspacePurpose: "project",
          label: "shared-a",
        },
        {
          id: "remote-b",
          kind: "workspace",
          workspacePath: "/workspace/shared",
          workspaceIdentity: "remote:server:source-b:/workspace/shared",
          workspacePurpose: "conversation",
          label: "shared-b",
        },
      ],
      attachments: [],
    });

    expect(projection.openWorkspaces).toHaveLength(2);
    expect(new Set(projection.openWorkspaces.map((item) => item.workspaceKey))).toEqual(
      new Set([
        "remote:server:source-a:/workspace/shared",
        "remote:server:source-b:/workspace/shared",
      ]),
    );
    expect(projection.projectHistory).toHaveLength(2);
  });

  it("keeps local tabs in execution contexts without projecting them as remote workspaces", () => {
    const projection = buildRemoteWorkspaceProjection({
      tabs: [
        {
          id: "local",
          kind: "workspace",
          workspacePath: "/local/project",
          workspacePurpose: "project",
          label: "project",
        },
        {
          id: "remote",
          kind: "workspace",
          workspacePath: "/remote/project",
          workspaceIdentity: "remote:server:11111111-1111-4111-8111-111111111111:/remote/project",
          workspacePurpose: "project",
          label: "project",
        },
      ],
    });

    expect(projection.openWorkspaces.map((item) => item.workspacePath)).toEqual([
      "/remote/project",
    ]);
    expect(projection.executionContexts).toEqual([
      expect.objectContaining({
        kind: "local",
        workspacePath: "/local/project",
      }),
      expect.objectContaining({
        kind: "remote",
        workspacePath: "/remote/project",
      }),
    ]);
    expect(projection.executionContexts[0]).not.toHaveProperty("attachmentState");
  });

  it("没有可信 attachment fact 时不会把在线 remote session 冒充成 ready", () => {
    const projection = buildRemoteWorkspaceProjection({
      managementSnapshot: createSnapshot(),
      tabs: [
        {
          id: "remote-session",
          kind: "workspace",
          workspacePath: "/workspace/project",
          workspaceIdentity:
            "remote:server:11111111-1111-4111-8111-111111111111:/workspace/project",
          remoteSessionId: "session-without-attachment-fact",
          label: "project",
        },
      ],
    });

    expect(projection.openWorkspaces[0]).toEqual(
      expect.objectContaining({ attachmentState: "attaching" }),
    );
  });
});
