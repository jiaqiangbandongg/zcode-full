import { describe, expect, it, vi, afterEach } from "vitest";
import {
  parseWebRemoteControlRelayV2IncomingMessage,
  parseWebRemoteControlRelayV2HttpResponse,
  WebRemoteControlV2Heartbeat,
  WebRemoteControlV2RetryPolicy,
} from "@zcode/shared/web-remote-relay";

afterEach(() => vi.useRealTimers());
describe("relay public boundary", () => {
  it("rejects legacy auth while accepting additive HTTP response fields", () => {
    expect(
      parseWebRemoteControlRelayV2IncomingMessage({
        type: "auth_ack",
        sid: "legacy",
        pair_status: "matched",
      }),
    ).toBeNull();
    expect(
      parseWebRemoteControlRelayV2HttpResponse("delete", { code: 0, msg: "ok", future: true }),
    ).toEqual({ code: 0, msg: "ok" });
  });
  it("keeps replacement history after handshake acknowledgement", () => {
    const retry = new WebRemoteControlV2RetryPolicy(() => 0);
    expect(retry.kickedDelay(1000)).toBe(2000);
    retry.acknowledged();
    expect(retry.kickedDelay(2000)).toBeNull();
  });
  it("cancels heartbeat and deadline when its transport is disposed", () => {
    vi.useFakeTimers();
    const query = vi.fn();
    const expired = vi.fn();
    const heartbeat = new WebRemoteControlV2Heartbeat(query, expired, {
      intervalMs: 10,
      jitterMs: 0,
      ackTimeoutMs: 30,
    });
    heartbeat.acknowledged();
    vi.advanceTimersByTime(10);
    expect(query).toHaveBeenCalledOnce();
    heartbeat.stop();
    vi.advanceTimersByTime(100);
    expect(query).toHaveBeenCalledOnce();
    expect(expired).not.toHaveBeenCalled();
  });
});
