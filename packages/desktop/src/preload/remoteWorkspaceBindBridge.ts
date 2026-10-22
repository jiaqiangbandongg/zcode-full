import type {
  BindRemoteWorkspaceSessionContextIpcResult,
  BindRemoteWorkspaceSessionContextResult,
} from "@zcode/shared";

export function unwrapRemoteWorkspaceBindResult(
  result: BindRemoteWorkspaceSessionContextIpcResult,
): BindRemoteWorkspaceSessionContextResult {
  if (result.success) return result.result;
  // Bug 原因：ipcMain.handle 抛出的 Error 经过 Electron invoke 后不会保留自定义属性。
  // wire 使用结构化结果，preload 在可信边界恢复 renderer 需要的稳定错误语义。
  const error = new Error(result.error) as Error & { code?: string; retryable?: boolean };
  if (result.reasonCode) error.code = result.reasonCode;
  if (result.retryable !== undefined) error.retryable = result.retryable;
  throw error;
}
