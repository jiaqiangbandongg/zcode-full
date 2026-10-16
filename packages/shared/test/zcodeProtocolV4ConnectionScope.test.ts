import { describe, expect, it } from "vitest";
import { hostAttachServicePortMessageSchema } from "../src/index.js";
import {
  subscribeParamsSchema,
  V4_METHODS,
  conversationResyncParamsSchema,
  v4ConnectionFlowParamsSchema,
  v4ConversationResyncParamsSchema,
  v4ConversationResyncResultSchema,
  v4ConversationSubscribeParamsSchema,
  v4ConversationSubscribeResultSchema,
  v4ConversationUnsubscribeParamsSchema,
  v4SessionsIndexSubscribeResultSchema,
  v4WorkspaceConfigSubscribeResultSchema,
} from "../src/zcode-protocol-v4/index.js";

describe("ZCode Protocol V4 trusted connection scope", () => {
  it("connection flow RPC 只接受 trusted connectionId 与三态控制", () => {
    expect(V4_METHODS.connectionFlow).toBe("v4/connection/flow");
    for (const state of ["saturated", "drained", "closed"] as const) {
      expect(
        v4ConnectionFlowParamsSchema.safeParse({ connectionId: "connection-1", state }).success,
      ).toBe(true);
    }
    expect(
      v4ConnectionFlowParamsSchema.safeParse({
        connectionId: "connection-1",
        state: "paused-by-ui",
      }).success,
    ).toBe(false);
    expect(
      v4ConnectionFlowParamsSchema.safeParse({
        connectionId: "connection-1",
        state: "saturated",
        topic: "conversation/forged",
      }).success,
    ).toBe(false);
  });

  it("UI-facing subscribe 不能选择 delivery profile 或 client mode", () => {
    expect(
      subscribeParamsSchema.safeParse({
        topic: "conversation/session-1",
        deliveryProfile: "replayable",
      }).success,
    ).toBe(false);
    expect(
      subscribeParamsSchema.safeParse({
        topic: "conversation/session-1",
        clientMode: "web-remote-replayable",
      }).success,
    ).toBe(false);
  });

  it("CLI-facing subscribe 必须带 host 注入的 connectionId/clientMode", () => {
    expect(
      v4ConversationSubscribeParamsSchema.safeParse({
        topic: "conversation/session-1",
        connectionId: "connection-1",
      }).success,
    ).toBe(false);
    expect(
      v4ConversationSubscribeParamsSchema.safeParse({
        topic: "conversation/session-1",
        connectionId: "connection-1",
        clientMode: "desktop-continuous",
      }).success,
    ).toBe(true);
    expect(
      v4ConversationSubscribeParamsSchema.safeParse({
        topic: "conversation/session-1",
        connectionId: "connection-1",
        clientMode: "mobile-self-declared",
      }).success,
    ).toBe(false);
  });

  it("AttachServicePort 只接受 host 可信的两种 clientMode", () => {
    for (const clientMode of ["desktop-continuous", "web-remote-replayable"] as const) {
      expect(
        hostAttachServicePortMessageSchema.safeParse({
          type: "attach-service-port",
          requestId: `request-${clientMode}`,
          attachmentId: `attachment-${clientMode}`,
          clientMode,
          scope: { kind: "local" },
        }).success,
      ).toBe(true);
    }
    expect(
      hostAttachServicePortMessageSchema.safeParse({
        type: "attach-service-port",
        requestId: "request-invalid",
        attachmentId: "attachment-invalid",
        clientMode: "mobile-self-declared",
        scope: { kind: "local" },
      }).success,
    ).toBe(false);
    expect(
      hostAttachServicePortMessageSchema.safeParse({
        type: "attach-service-port",
      }).success,
    ).toBe(false);
  });

  it("CLI-facing unsubscribe 必须严格携带 topic/subscriptionId/connectionId", () => {
    expect(
      v4ConversationUnsubscribeParamsSchema.safeParse({
        subscriptionId: "sub-1",
      }).success,
    ).toBe(false);
    expect(
      v4ConversationUnsubscribeParamsSchema.safeParse({
        topic: "conversation/session-1",
        subscriptionId: "sub-1",
        connectionId: "connection-1",
      }).success,
    ).toBe(true);
    expect(
      v4ConversationUnsubscribeParamsSchema.safeParse({
        topic: "conversation/session-1",
        subscriptionId: "sub-1",
        connectionId: "connection-1",
        forged: true,
      }).success,
    ).toBe(false);
  });

  it("same-sub resync 只接受 subscriptionId/base/forceSnapshot 且结果 strict ACK", () => {
    expect(V4_METHODS.conversationResync).toBe("v4/conversation/resync");
    expect(
      conversationResyncParamsSchema.safeParse({
        subscriptionId: "sub-1",
        base: { logEpoch: "epoch-1", seq: 7 },
      }).success,
    ).toBe(true);
    expect(
      conversationResyncParamsSchema.safeParse({
        subscriptionId: "sub-1",
        base: null,
        forceSnapshot: true,
      }).success,
    ).toBe(true);
    expect(
      conversationResyncParamsSchema.safeParse({
        subscriptionId: "sub-1",
        base: null,
        topic: "conversation/forged",
      }).success,
    ).toBe(false);
    expect(
      v4ConversationResyncParamsSchema.safeParse({
        topic: "conversation/session-1",
        connectionId: "connection-1",
        subscriptionId: "sub-1",
        base: null,
      }).success,
    ).toBe(true);
    expect(
      v4ConversationResyncParamsSchema.safeParse({
        subscriptionId: "sub-1",
        base: null,
      }).success,
    ).toBe(false);
    const ack = { subscriptionId: "sub-1", mode: "resume" as const, logEpoch: "epoch-1" };
    expect(v4ConversationResyncResultSchema.safeParse({ ack }).success).toBe(true);
    expect(v4ConversationResyncResultSchema.safeParse({ ack, frame: null }).success).toBe(false);
  });

  it.each([
    ["conversation", v4ConversationSubscribeResultSchema],
    ["sessions-index", v4SessionsIndexSubscribeResultSchema],
    ["workspace-config", v4WorkspaceConfigSubscribeResultSchema],
  ])("%s subscribe result 只接受 strict ACK", (_topic, schema) => {
    const ack = {
      subscriptionId: "sub-1",
      mode: "snapshot" as const,
      logEpoch: "epoch-1",
    };

    expect(schema.safeParse({ ack }).success).toBe(true);
    expect(schema.safeParse({ ack, frame: null }).success).toBe(false);
  });
});
