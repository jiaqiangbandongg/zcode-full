import { describe, expect, it } from "vitest";
import {
  MCP_SERVER_FAILURE_KINDS,
  zcodeMcpServerStatusSnapshotSchema,
} from "../src/zcode-protocol/index.js";

describe("MCP status diagnostics protocol", () => {
  it("accepts structured failure diagnostics and keeps legacy snapshots compatible", () => {
    expect(
      zcodeMcpServerStatusSnapshotSchema.parse({
        error: "raw sdk error",
        failureKind: "server_unavailable",
        serverRequestId: "20260822000000abcdef1234567890abcd",
        status: "failed",
        toolCount: 0,
        transport: "http",
        updatedAt: "2026-08-22T00:00:00.000Z",
      }),
    ).toMatchObject({
      failureKind: "server_unavailable",
      serverRequestId: "20260822000000abcdef1234567890abcd",
    });

    expect(
      zcodeMcpServerStatusSnapshotSchema.parse({
        status: "connected",
        toolCount: 3,
        transport: "stdio",
        updatedAt: "2026-08-22T00:00:00.000Z",
      }),
    ).not.toHaveProperty("failureKind");
  });

  it("enumerates every user-facing failure kind and rejects empty request ids", () => {
    expect(MCP_SERVER_FAILURE_KINDS).toEqual([
      "config_invalid",
      "runtime_unavailable",
      "process_start_failed",
      "network_unreachable",
      "connection_timeout",
      "protocol_negotiation_failed",
      "tool_list_failed",
      "unexpected_disconnect",
      "oauth_authorization_failed",
      "official_origin_untrusted",
      "not_authenticated",
      "coding_plan_required",
      "server_not_found",
      "server_unavailable",
      "rate_limited",
      "server_internal_error",
      "protocol_error",
      "status_unavailable",
      "connection_failed",
    ]);

    expect(
      zcodeMcpServerStatusSnapshotSchema.safeParse({
        serverRequestId: "",
        status: "failed",
        toolCount: 0,
        transport: "http",
        updatedAt: "2026-08-22T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });
});
