import { isPublicZCodeErrorCode } from "@zcode/shared";
export const REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE = "ZCODE_REMOTE_WORKSPACE_DISCONNECTED";

export function createRemoteWorkspaceDisconnectedError(): Error & {
  code: typeof REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE;
} {
  const error = new Error(REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE) as Error & {
    code: typeof REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE;
  };
  error.code = REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE;
  return error;
}

export function isRemoteWorkspaceDisconnectedError(error: unknown): boolean {
  // RPC/Proxy 边界可能保留 Error，也可能只保留 code/message 字段。
  // 只接受精确错误码，避免用 includes 把真实业务错误误判成初始化等待态。
  if (error === REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE) {
    return true;
  }

  if (typeof error !== "object" || error === null) {
    return false;
  }

  const candidate = error as { code?: unknown; message?: unknown };
  return (
    candidate.code === REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE ||
    candidate.message === REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE
  );
}

/** 仅识别远程协议的结构化码，不能把模型网络报错或普通业务文案猜成设备断线。 */
export function getRemoteConnectionFailureCode(error: unknown): string | undefined {
  if (isRemoteWorkspaceDisconnectedError(error)) return REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE;
  if (!error || typeof error !== "object" || !("code" in error) || typeof error.code !== "string")
    return undefined;
  return isPublicZCodeErrorCode(error.code) ? error.code : undefined;
}
