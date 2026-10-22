import type { OAuthCachedSessionRestoreResult, UserInfo } from "@zcode/shared";
import type { AlertDialogRequest } from "@/store/alertDialogStore.js";

/** 启动过期和运行时撤销使用同一登录恢复入口，不重启进程或保留头像展示。 */
export async function requestOAuthReauthentication(params: {
  setUser: (user: UserInfo | null) => void;
  requestAlert: (request: AlertDialogRequest) => Promise<boolean>;
  onReauthenticationRequired: () => void;
  copy: AlertDialogRequest;
  shouldReauthenticate?: () => Promise<boolean>;
}): Promise<void> {
  if (params.shouldReauthenticate && !(await params.shouldReauthenticate())) return;
  params.setUser(null);
  await params.requestAlert(params.copy);
  // 提示等待期间可能已完成新登录；只消费 owner 仍处于退出状态的旧过期事件。
  if (params.shouldReauthenticate && !(await params.shouldReauthenticate())) return;
  params.onReauthenticationRequired();
}

export async function applyCachedOAuthSessionRestoreResult(params: {
  result: OAuthCachedSessionRestoreResult;
  setUser: (user: UserInfo | null) => void;
  requestAlert: (request: AlertDialogRequest) => Promise<boolean>;
  onReauthenticationRequired: () => void;
  copy: AlertDialogRequest;
  shouldReauthenticate?: () => Promise<boolean>;
}): Promise<boolean> {
  if (params.result.status === "authenticated") {
    params.setUser(params.result.userInfo);
    return true;
  }

  if (params.result.status === "reauthentication-required") {
    // 认证事实已经失效，不能等用户确认弹窗后才清 UI 登录态。
    await requestOAuthReauthentication(params);
  }

  return false;
}
