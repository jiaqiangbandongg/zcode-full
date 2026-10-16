import { Event } from "@zcode/rpc";
import { conversationShareConnectionScopeFactory } from "@zcode/services/node";
import { describe, expect, it, vi } from "vitest";
import { scopeConversationShareServiceForAttachment } from "../src/host/conversationShareAttachmentService.js";

function service() {
  const scoped = {
    getCapabilities: vi.fn(),
    publish: vi.fn(),
    onDynamicPublishProgress: () => Event.None,
    importShare: vi.fn(),
    onDynamicImportProgress: () => Event.None,
    getPreview: vi.fn(),
    getContinuation: vi.fn(),
  };
  return {
    getCapabilities: vi.fn(),
    publish: vi.fn(),
    onDynamicPublishProgress: () => Event.None,
    importShare: vi.fn(),
    onDynamicImportProgress: () => Event.None,
    getPreview: vi.fn(),
    getContinuation: vi.fn(),
    [conversationShareConnectionScopeFactory]: vi.fn(() => scoped),
    scoped,
  };
}

describe("conversation share attachment scope", () => {
  it("Desktop 绑定 attachment Agent scope，mobile 不创建 scope 并拒绝发布", async () => {
    const desktop = service();
    const agentService = { connection: "desktop" };
    expect(
      scopeConversationShareServiceForAttachment(
        desktop,
        "desktop-continuous",
        agentService as never,
      ),
    ).toBe(desktop.scoped);
    expect(desktop[conversationShareConnectionScopeFactory]).toHaveBeenCalledWith(agentService);

    const mobileService = service();
    const mobile = scopeConversationShareServiceForAttachment(
      mobileService,
      "web-remote-replayable",
      { connection: "mobile" } as never,
    ) as ReturnType<typeof service>;
    expect(mobileService[conversationShareConnectionScopeFactory]).not.toHaveBeenCalled();
    await expect(mobile.publish({} as never, "op")).rejects.toMatchObject({
      kind: "feature_disabled",
    });
    await expect(
      mobile.getContinuation({ shareCode: "share", clientRequestId: "request" }),
    ).rejects.toMatchObject({ kind: "feature_disabled" });
    await expect(
      mobile.importShare({ shareCode: "share", clientRequestId: "request" }, "op"),
    ).rejects.toMatchObject({ kind: "feature_disabled" });
  });

  it("Desktop 缺少 Agent scope 时只拒绝发布，导入仍委托原服务", async () => {
    const desktop = service();
    desktop.importShare.mockResolvedValueOnce({ workspacePath: "/imported" });
    const scoped = scopeConversationShareServiceForAttachment(desktop, "desktop-continuous");

    await expect(scoped.publish({} as never, "op")).rejects.toMatchObject({
      kind: "connection_unavailable",
    });
    await expect(
      scoped.importShare({ shareCode: "share", clientRequestId: "request" }, "import-op"),
    ).resolves.toEqual({ workspacePath: "/imported" });
    expect(desktop.importShare).toHaveBeenCalledTimes(1);
  });
});
