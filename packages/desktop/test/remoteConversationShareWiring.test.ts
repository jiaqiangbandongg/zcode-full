import { describe, expect, it, vi } from "vitest";
import { IConversationShareService, type IServiceAccessor } from "@zcode/services";
import { createServerRemoteWorkspaceServiceCollection } from "@desktop/host/remoteWorkspaceServiceCollection.js";
import { REMOTE_WORKSPACE_RPC_CHANNELS } from "@desktop/host/remoteWorkspaceRpcContract.js";
import { scopeConversationShareServiceForAttachment } from "@desktop/host/conversationShareAttachmentService.js";

const input = {
  workspacePath: "/remote/project",
  workspaceIdentity: "remote:server:device:/remote/project",
  remoteSessionId: "remote-session",
  sessionId: "session",
  selection: { kind: "productTurns" as const, productTurnIds: ["turn"] },
};
function fixture() {
  const preflight = vi.fn(async () => ({ remote: true }));
  const credential = {
    load: vi.fn(() => {
      throw new Error("Desktop 不得读凭据替远端发布");
    }),
  };
  const connectionServices = {
    ...Object.fromEntries(REMOTE_WORKSPACE_RPC_CHANNELS.map((key) => [key, {}])),
    credentialService: credential,
    conversationShareService: { preflight, publish: vi.fn(), getCapabilities: vi.fn() },
  } as unknown as IServiceAccessor;
  const clientConfigService = { getSnapshot: vi.fn(async () => ({ pluginStoreOrder: null })) };
  return { clientConfigService, connectionServices, preflight, credential };
}

describe("R3 远程分享装配", () => {
  it.each(["ssh", "wsl", "docker"] as const)(
    "%s 直接使用 Source 分享服务，不读取 Desktop 或远端 Secret",
    async (targetKind) => {
      const f = fixture();
      const service = createServerRemoteWorkspaceServiceCollection({ ...f, targetKind }).get(
        IConversationShareService,
      );
      await expect(service.preflight(input)).resolves.toEqual({ remote: true });
      expect(f.preflight).toHaveBeenCalledWith(input);
      expect(f.credential.load).not.toHaveBeenCalled();
    },
  );
  it("server 直连仍禁止分享", async () => {
    const f = fixture();
    const service = createServerRemoteWorkspaceServiceCollection({
      ...f,
      targetKind: "server",
    }).get(IConversationShareService);
    await expect(service.preflight(input)).rejects.toMatchObject({ kind: "feature_disabled" });
    expect(f.preflight).not.toHaveBeenCalled();
  });
  it("手机即使附着可用 Source 也不能发布", async () => {
    const f = fixture();
    const raw = createServerRemoteWorkspaceServiceCollection({ ...f, targetKind: "ssh" }).get(
      IConversationShareService,
    );
    const service = scopeConversationShareServiceForAttachment(raw, "web-remote-replayable");
    await expect(service.preflight(input)).rejects.toMatchObject({ kind: "feature_disabled" });
    await expect(service.publish({} as never, "op")).rejects.toMatchObject({
      kind: "feature_disabled",
    });
    expect(f.preflight).not.toHaveBeenCalled();
  });
  it("重新装配使用新连接，不能保留旧 Source 服务", async () => {
    const old = fixture();
    const next = fixture();
    createServerRemoteWorkspaceServiceCollection({ ...old, targetKind: "ssh" });
    const current = createServerRemoteWorkspaceServiceCollection({
      ...next,
      targetKind: "ssh",
    }).get(IConversationShareService);
    await current.preflight(input);
    expect(next.preflight).toHaveBeenCalledOnce();
    expect(old.preflight).not.toHaveBeenCalled();
  });
});
