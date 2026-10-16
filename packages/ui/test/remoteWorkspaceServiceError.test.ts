import { describe, expect, it } from "vitest";
import {
  isRemoteWorkspaceDisconnectedError,
  REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE,
} from "@/lib/remoteWorkspaceServiceError.js";

describe("remoteWorkspaceServiceError", () => {
  it("识别本地 Error 和 RPC 序列化后的远端断连错误", () => {
    expect(
      isRemoteWorkspaceDisconnectedError(
        Object.assign(new Error(REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE), {
          code: REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE,
        }),
      ),
    ).toBe(true);
    expect(
      isRemoteWorkspaceDisconnectedError({
        code: REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE,
      }),
    ).toBe(true);
    expect(
      isRemoteWorkspaceDisconnectedError({
        message: REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE,
      }),
    ).toBe(true);
    expect(
      isRemoteWorkspaceDisconnectedError(
        REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE,
      ),
    ).toBe(true);
  });

  it("不吞掉普通 RPC 和业务错误", () => {
    expect(isRemoteWorkspaceDisconnectedError(new Error("RPC channel closed"))).toBe(
      false,
    );
    expect(
      isRemoteWorkspaceDisconnectedError({
        code: "EACCES",
        message: `wrapped ${REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE}`,
      }),
    ).toBe(false);
  });
});
