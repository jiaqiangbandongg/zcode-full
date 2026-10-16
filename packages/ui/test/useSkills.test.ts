// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import type { ZCodeSkillsReferenceCatalogResult } from "@zcode/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getSkillReferenceCatalog =
  vi.fn<(params: unknown) => Promise<ZCodeSkillsReferenceCatalogResult>>();
let runtimeRestartListener: ((event: { workspaceKey: string }) => void) | undefined;
const runtimeRestartSubscription = { dispose: vi.fn() };
const onAgentRuntimeRestarted = vi.fn((listener: (event: { workspaceKey: string }) => void) => {
  runtimeRestartListener = listener;
  return runtimeRestartSubscription;
});
const resolution = {
  services: {
    zcodeAgentService: {
      getSkillReferenceCatalog,
      onAgentRuntimeRestarted,
    },
  },
  remoteSessionId: null as string | null,
  isRemoteTarget: false,
  connectionKind: "local-ready" as const,
  rpcReady: true,
};
const useWorkspaceServicesResolution = vi.fn(() => resolution);

vi.mock("@/hooks/useWorkspaceServices.js", () => ({ useWorkspaceServicesResolution }));
vi.mock("@/logger.js", () => ({ logger: { warn: vi.fn() } }));

function catalog(name: string, authority: "session" | "workspace") {
  return {
    authority,
    skills: [
      {
        id: `glm:workspace:/workspace/.zcode/skills/${name}/SKILL.md`,
        name,
        description: `${name} description`,
        path: `/workspace/.zcode/skills/${name}/SKILL.md`,
        scope: "workspace" as const,
        enabled: true,
      },
    ],
  } satisfies ZCodeSkillsReferenceCatalogResult;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("useSkills conversation catalog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSkillReferenceCatalog.mockReset();
    runtimeRestartListener = undefined;
    resolution.remoteSessionId = null;
    resolution.rpcReady = true;
  });

  it("uses workspace authority for a draft and Session authority for an existing conversation", async () => {
    getSkillReferenceCatalog
      .mockResolvedValueOnce(catalog("draft-current", "workspace"))
      .mockResolvedValueOnce(catalog("session-frozen", "session"));
    const { useSkills } = await import("@/hooks/useSkills.js");
    const hook = renderHook(
      (props: { sessionId: string | null }) =>
        useSkills({
          workspacePath: "/workspace",
          workspaceIdentity: "ssh://host/workspace",
          sessionId: props.sessionId,
          enabled: true,
        }),
      { initialProps: { sessionId: null } },
    );

    await waitFor(() => expect(hook.result.current.skills[0]?.name).toBe("draft-current"));
    expect(getSkillReferenceCatalog).toHaveBeenLastCalledWith({
      workspacePath: "/workspace",
      workspaceIdentity: "ssh://host/workspace",
    });

    hook.rerender({ sessionId: "session-a" });
    expect(hook.result.current.skills).toEqual([]);
    await waitFor(() => expect(hook.result.current.skills[0]?.name).toBe("session-frozen"));
    expect(getSkillReferenceCatalog).toHaveBeenLastCalledWith({
      workspacePath: "/workspace",
      workspaceIdentity: "ssh://host/workspace",
      sessionId: "session-a",
    });
    hook.unmount();
  });

  it("refetches after runtime restart and rejects a late previous-runtime result", async () => {
    const oldRuntime = deferred<ZCodeSkillsReferenceCatalogResult>();
    const newRuntime = deferred<ZCodeSkillsReferenceCatalogResult>();
    getSkillReferenceCatalog
      .mockReturnValueOnce(oldRuntime.promise)
      .mockReturnValueOnce(newRuntime.promise);
    const { useSkills } = await import("@/hooks/useSkills.js");
    const hook = renderHook(() =>
      useSkills({
        workspacePath: "/workspace",
        workspaceIdentity: "ssh://host/workspace",
        sessionId: "session-a",
        enabled: true,
      }),
    );
    await waitFor(() => expect(getSkillReferenceCatalog).toHaveBeenCalledTimes(1));

    act(() => runtimeRestartListener?.({ workspaceKey: "ssh://host/workspace" }));
    await waitFor(() => expect(getSkillReferenceCatalog).toHaveBeenCalledTimes(2));

    await act(async () => {
      newRuntime.resolve(catalog("runtime-new", "session"));
      await newRuntime.promise;
    });
    await waitFor(() => expect(hook.result.current.skills[0]?.name).toBe("runtime-new"));

    await act(async () => {
      oldRuntime.resolve(catalog("runtime-stale", "session"));
      await oldRuntime.promise;
    });
    expect(hook.result.current.skills[0]?.name).toBe("runtime-new");
    hook.unmount();
    expect(runtimeRestartSubscription.dispose).toHaveBeenCalled();
  });

  it("isolates remote attachments and stays empty while the target RPC is unavailable", async () => {
    getSkillReferenceCatalog.mockResolvedValue(catalog("remote", "session"));
    const { useSkills } = await import("@/hooks/useSkills.js");
    const hook = renderHook(
      (props: { revision: number }) => {
        void props.revision;
        return useSkills({
          workspacePath: "/workspace",
          workspaceIdentity: "ssh://host/workspace",
          sessionId: "session-a",
          enabled: true,
        });
      },
      { initialProps: { revision: 0 } },
    );
    await waitFor(() => expect(hook.result.current.skills).toHaveLength(1));

    resolution.rpcReady = false;
    hook.rerender({ revision: 1 });
    expect(hook.result.current).toMatchObject({ skills: [], loading: false, error: null });

    resolution.rpcReady = true;
    resolution.remoteSessionId = "remote-runtime-b";
    hook.rerender({ revision: 2 });
    await waitFor(() => expect(getSkillReferenceCatalog).toHaveBeenCalledTimes(2));
    expect(getSkillReferenceCatalog).toHaveBeenLastCalledWith({
      workspacePath: "/workspace",
      workspaceIdentity: "ssh://host/workspace",
      remoteSessionId: "remote-runtime-b",
      sessionId: "session-a",
    });
    hook.unmount();
  });
});
