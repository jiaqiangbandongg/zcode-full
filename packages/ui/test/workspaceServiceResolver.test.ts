import { describe, expect, it } from "vitest";
import type { IServiceAccessor } from "@zcode/services";
import {
  resolveWorkspaceRemoteSessionId,
  resolveWorkspaceServices,
  type WorkspaceServiceResolverState,
} from "@/lib/workspaceServiceResolver.js";

const SSH_115_IDENTITY = "remote:ssh:115.190.186.228:22:root:/root";
const LOCALHOST_IDENTITY = "remote:ssh:localhost:2222:root:/root";

function createResolverState(): {
  services: IServiceAccessor;
  state: WorkspaceServiceResolverState;
} {
  const services = {} as IServiceAccessor;
  return {
    services,
    state: {
      sessionsById: {
        "session-115": { services },
      },
      sessionIdByWorkspaceIdentity: {
        [SSH_115_IDENTITY]: "session-115",
      },
      sessionIdByWorkspacePath: {
        "/root": "session-115",
      },
    },
  };
}

describe("workspace service resolver 的远端身份隔离", () => {
  it("有 workspaceIdentity 时不会按同路径借用另一 SSH endpoint", () => {
    const { services, state } = createResolverState();
    const target = {
      workspacePath: "/root",
      workspaceIdentity: LOCALHOST_IDENTITY,
      remoteTarget: { kind: "ssh" },
    };

    expect(resolveWorkspaceRemoteSessionId(target, state)).toBeUndefined();
    expect(resolveWorkspaceServices(target, services, state)).toBeNull();
  });

  it("workspaceIdentity 精确绑定时返回对应远端 services", () => {
    const { services, state } = createResolverState();
    const target = {
      workspacePath: "/root",
      workspaceIdentity: SSH_115_IDENTITY,
      remoteTarget: { kind: "ssh" },
    };

    expect(resolveWorkspaceRemoteSessionId(target, state)).toBe("session-115");
    expect(resolveWorkspaceServices(target, services, state)).toEqual({
      services,
      remoteSessionId: "session-115",
      isRemoteWorkspace: true,
    });
  });

  it("无 workspaceIdentity 的旧 remote tab 仍允许按路径恢复 session", () => {
    const { services, state } = createResolverState();
    const target = {
      workspacePath: "/root",
      remoteTarget: { kind: "ssh" },
    };

    expect(resolveWorkspaceRemoteSessionId(target, state)).toBe("session-115");
    expect(resolveWorkspaceServices(target, services, state)?.services).toBe(services);
  });
});
