import { describe, expect, it } from "vitest";
import { unwrapRemoteWorkspaceBindResult } from "../src/preload/remoteWorkspaceBindBridge.js";

describe("remote workspace bind preload bridge", () => {
  it("restores structured reasonCode and retryable metadata for renderer callers", async () => {
    const error = await Promise.resolve()
      .then(() =>
        unwrapRemoteWorkspaceBindResult({
          success: false,
          error: "workspace migration conflict",
          reasonCode: "workspace-task-identity-conflict",
          retryable: false,
        }),
      )
      .catch((value: unknown) => value);

    expect(error).toMatchObject({
      message: "workspace migration conflict",
      code: "workspace-task-identity-conflict",
      retryable: false,
    });
  });
});
