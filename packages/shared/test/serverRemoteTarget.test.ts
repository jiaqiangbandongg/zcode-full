import { describe, expect, it } from "vitest";
import {
  buildServerRemoteWorkspaceIdentity,
  isRemoteWorkspaceIdentity,
  parseRemoteWorkspaceIdentity,
} from "../src/remote-workspace-identity.js";
import {
  hostIncomingMessageSchema,
  remoteTargetSchema,
} from "../src/validation.js";

describe("server remote target", () => {
  it("accepts server remote target payloads", () => {
    const parsed = remoteTargetSchema.safeParse({
      kind: "server",
      url: "https://intranet.example.invalid:3030",
      name: "Studio",
      token: "secret",
      workspacePath: "/Users/dev/ZCodeProject",
      serverId: "studio",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toMatchObject({
        kind: "server",
        url: "https://intranet.example.invalid:3030",
      });
    }
  });

  it("accepts server target in window Host connect messages", () => {
    const parsed = hostIncomingMessageSchema.safeParse({
      type: "connect-remote-workspace",
      requestId: "connect-server-1",
      target: {
        kind: "server",
        url: "https://intranet.example.invalid:3030",
        workspacePath: "/Users/dev/ZCodeProject",
        serverId: "studio",
      },
      remoteAssets: {},
      workspacePath: "/Users/dev/ZCodeProject",
      workspaceIdentity:
        "remote:server:studio:/Users/dev/ZCodeProject",
    });

    expect(parsed.success).toBe(true);
  });

  it("builds and parses server workspace identities", () => {
    const identity = buildServerRemoteWorkspaceIdentity({
      serverId: "Studio Server 01",
      workspacePath: "\\Users\\dev\\ZCodeProject\\",
    });

    expect(identity).toBe(
      "remote:server:studio-server-01:/Users/dev/ZCodeProject",
    );
    expect(parseRemoteWorkspaceIdentity(identity)).toEqual({
      kind: "server",
      workspacePath: "/Users/dev/ZCodeProject",
    });
    expect(isRemoteWorkspaceIdentity(identity)).toBe(true);
  });

  it("rejects malformed server targets and identities", () => {
    expect(
      remoteTargetSchema.safeParse({ kind: "server", url: "not a url" })
        .success,
    ).toBe(false);
    expect(parseRemoteWorkspaceIdentity("remote:server::/workspace")).toBeNull();
    expect(parseRemoteWorkspaceIdentity("remote:server:studio:relative")).toBeNull();
  });
});
