import { describe, expect, it, vi } from "vitest";
import type { ConversationRow } from "@zcode/shared";
import { ConversationShareService } from "../src/conversation-share/conversationShareService.js";
import { ConversationShareHttpClient } from "../src/conversation-share/conversationShareHttpClient.js";
import { scopeConversationShareServiceForAttachment } from "../src/conversation-share/conversationShareConnectionScope.js";
import {
  createZCodeAgentConnectionScope,
  readTrustedZCodeAgentV4Connection,
} from "../src/zcode-agent/zcodeAgentConnectionScope.js";

const input = {
  workspacePath: "/workspace",
  workspaceIdentity: "remote:server:device:/workspace",
  remoteSessionId: "generation-1",
  sessionId: "task",
  selection: { kind: "productTurns" as const, productTurnIds: ["turn"] },
};
const context = { connectionId: "desktop-port", clientMode: "desktop-continuous" as const };
const rows: ConversationRow[] = [
  {
    kind: "turnHeader",
    rowId: 1,
    entityId: "header",
    turnId: "turn",
    productTurnId: "turn",
    createdAt: 1,
    createdAtSeq: 1,
    origin: "userInput",
    state: "completedSuccess",
    startedAt: 1,
    endedAt: 2,
  },
  {
    kind: "assistantText",
    rowId: 2,
    turnId: "turn",
    productTurnId: "turn",
    createdAt: 2,
    createdAtSeq: 2,
    text: "completed",
    state: "complete",
  },
];
function fixture() {
  let remoteToken: string | null = "remote-account-B";
  const remoteCredential = vi.fn(async () => remoteToken);
  const request = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          code: 0,
          msg: "ok",
          data: {
            schema_version: 1,
            ttl_ms: 60_000,
            access_modes: ["private"],
            max_rows: 100,
            max_payload_bytes: 100_000,
            max_artifact_count: 0,
            max_artifact_bytes: 1,
            max_total_artifact_bytes: 1,
            allowed_artifacts: [],
          },
        }),
        { status: 200 },
      ),
  );
  const conversationRowsRangeV4 = vi.fn(async (params: unknown) => {
    expect(readTrustedZCodeAgentV4Connection(params)?.clientMode).toBe("desktop-continuous");
    return { rows, atSeq: 2, atRevision: 1, atLogEpoch: "epoch", hasMore: false };
  });
  const agent = {
    conversationRowsRangeV4,
    conversationFileChangesV4: vi.fn(),
    conversationAttachmentReadV4: vi.fn(),
    conversationAttachmentStatV4: vi.fn(),
  };
  const relayContext = {
    connectionId: "source-ws",
    clientMode: "desktop-continuous" as const,
    role: "trusted-host-relay" as const,
  };
  const scope = createZCodeAgentConnectionScope(agent as never, relayContext);
  const real = new ConversationShareService({
    zcodeAgentService: agent as never,
    client: new ConversationShareHttpClient({
      apiClient: { request },
      baseUrl: "https://remote-account-api.invalid/api/v1",
      tokenProvider: remoteCredential,
    }),
    artifactSource: { read: vi.fn() },
  });
  const source = scopeConversationShareServiceForAttachment(
    real,
    "desktop-continuous",
    scope.service,
    relayContext,
  );
  // 模拟 RPC 代理只暴露公开方法，不能把进程内 symbol factory 穿过网络。
  const rpc = { ...source, preflight: vi.fn(source.preflight) };
  const desktop = scopeConversationShareServiceForAttachment(
    rpc,
    "desktop-continuous",
    undefined,
    context,
  );
  return {
    real,
    source,
    desktop,
    rpc,
    scope,
    request,
    remoteCredential,
    conversationRowsRangeV4,
    logout: () => {
      remoteToken = null;
    },
  };
}

describe("Source Share RPC 的账号与连接边界", () => {
  it("只读 Source 的 B 账号，覆盖调用方伪造 carrier，并复用 Agent relay 的命名空间", async () => {
    const f = fixture();
    try {
      const result = await f.desktop.preflight({
        ...input,
        __zcodeTrustedV4Connection: { connectionId: "forged", clientMode: "web-remote-replayable" },
        jwt: "local-account-A",
      } as typeof input);
      expect(result.blockingIssues).toEqual([]);
      expect(f.remoteCredential).toHaveBeenCalledOnce();
      expect(f.request).toHaveBeenCalledWith(
        "https://remote-account-api.invalid/api/v1/shares/capabilities",
        expect.objectContaining({
          headers: expect.objectContaining({ authorization: "Bearer remote-account-B" }),
        }),
      );
      const received = readTrustedZCodeAgentV4Connection(f.rpc.preflight.mock.calls[0]?.[0]);
      expect(received).toEqual(context);
      const shareRoute = readTrustedZCodeAgentV4Connection(
        f.conversationRowsRangeV4.mock.calls[0]?.[0],
      );
      await f.scope.service.conversationRowsRangeV4({
        ...input,
        __zcodeTrustedV4Connection: context,
      } as never);
      expect(
        readTrustedZCodeAgentV4Connection(f.conversationRowsRangeV4.mock.calls[1]?.[0]),
      ).toEqual(shareRoute);
      expect(shareRoute?.connectionId).not.toBe(context.connectionId);
      expect(f.conversationRowsRangeV4.mock.calls[0]?.[0]).toMatchObject({
        workspaceIdentity: input.workspaceIdentity,
        remoteSessionId: input.remoteSessionId,
      });
    } finally {
      await f.scope.dispose();
    }
  });
  it("远端退出后拒绝，无本地账号回退", async () => {
    const f = fixture();
    try {
      f.logout();
      await expect(f.desktop.preflight(input)).rejects.toMatchObject({
        kind: "authentication_required",
      });
      expect(f.request).not.toHaveBeenCalled();
      expect(f.conversationRowsRangeV4).not.toHaveBeenCalled();
    } finally {
      await f.scope.dispose();
    }
  });
  it("trusted Host 没有携带下游身份时不能发起分享", async () => {
    const f = fixture();
    try {
      await expect(f.source.preflight(input)).rejects.toMatchObject({
        kind: "connection_unavailable",
      });
      expect(f.request).not.toHaveBeenCalled();
    } finally {
      await f.scope.dispose();
    }
  });
  it("Source 普通 Web 入口即使伪造 desktop carrier 也被拒绝", async () => {
    const f = fixture();
    try {
      const web = scopeConversationShareServiceForAttachment(
        f.real,
        "web-remote-replayable",
        f.scope.service,
      );
      const forged = { ...input, __zcodeTrustedV4Connection: context };
      await expect(web.preflight(forged)).rejects.toMatchObject({ kind: "feature_disabled" });
      await expect(web.publish(forged as never, "op")).rejects.toMatchObject({
        kind: "feature_disabled",
      });
      expect(f.request).not.toHaveBeenCalled();
    } finally {
      await f.scope.dispose();
    }
  });
});
