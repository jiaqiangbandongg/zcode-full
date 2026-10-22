import { describe, expect, it } from "vitest";
import { scopedServicePortPayloadSchema } from "../src/validation.js";

const validPayload = {
  attachmentId: "attachment-project",
  sessionId: "project-session",
  target: { kind: "docker", container: "dev" } as const,
  sourceServerId: "source-1",
  workspacePath: "/remote/project",
  workspaceIdentity: "remote:server:source-1:/remote/project",
  workspacePurpose: "project" as const,
};

describe("scopedServicePortPayloadSchema", () => {
  it("保留完整 remote workspace scope", () => {
    expect(scopedServicePortPayloadSchema.parse(validPayload)).toEqual(validPayload);
  });

  it("拒绝缺失 scope 或携带未知字段的 payload", () => {
    const { workspaceIdentity: _workspaceIdentity, ...missingScope } = validPayload;

    expect(scopedServicePortPayloadSchema.safeParse(missingScope).success).toBe(false);
    expect(
      scopedServicePortPayloadSchema.safeParse({
        ...validPayload,
        unexpectedScope: "remote:server:other:/remote/project",
      }).success,
    ).toBe(false);
  });
});
