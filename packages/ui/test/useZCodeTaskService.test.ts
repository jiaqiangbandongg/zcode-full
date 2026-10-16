import { describe, expect, it } from "vitest";
import { buildSnapshotDedupeKey } from "../src/hooks/useZCodeTaskService.js";

describe("buildSnapshotDedupeKey", () => {
  it("separates replayable snapshots by historical model hint", () => {
    const base = {
      taskId: "task-1",
      workspacePath: "/workspace/demo",
      workspaceIdentity: "ssh://host/workspace/demo",
      clientMode: "web-remote-replayable" as const,
      messageLimit: 10,
    };

    expect(
      buildSnapshotDedupeKey({
        ...base,
        model: "default-deepseek/deepseek-v4-flash",
      }),
    ).not.toBe(
      buildSnapshotDedupeKey({
        ...base,
        model: "bigmodel-api/GLM-5.1",
      }),
    );
  });

  it("separates replayable snapshots by historical thought level hint", () => {
    const base = {
      taskId: "task-1",
      workspacePath: "/workspace/demo",
      workspaceIdentity: "ssh://host/workspace/demo",
      clientMode: "web-remote-replayable" as const,
      messageLimit: 10,
      model: "bigmodel-api/GLM-5.2",
    };

    expect(
      buildSnapshotDedupeKey({
        ...base,
        thoughtLevel: "high",
      }),
    ).not.toBe(
      buildSnapshotDedupeKey({
        ...base,
        thoughtLevel: "max",
      }),
    );
  });

  it("separates replayable snapshots by resume model policy", () => {
    const base = {
      taskId: "task-1",
      workspacePath: "/workspace/demo",
      clientMode: "web-remote-replayable" as const,
    };

    expect(buildSnapshotDedupeKey(base)).not.toBe(
      buildSnapshotDedupeKey({
        ...base,
        resumeModelPolicy: "ui-resolved-only",
      }),
    );
  });
});
