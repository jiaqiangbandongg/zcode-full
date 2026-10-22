import { describe, expect, it } from "vitest";
import { zcodeMcpServerStatusSnapshotSchema } from "../src/zcode-protocol/index.js";

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

  it("rejects empty request ids", () => {
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
