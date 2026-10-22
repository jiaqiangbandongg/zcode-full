import { useEffect, useRef } from "react";
import type {
  WebRemoteControlAuthPlatform,
  WebRemoteControlAuthEvents,
} from "@/web-remote-control/contract.js";

/** 初始恢复同步一次投影；运行中的认证变更只消费 OAuth owner 的凭据完成事件。 */
export function useWebRemoteControlAuthSync(
  platform: WebRemoteControlAuthPlatform,
  oauth: WebRemoteControlAuthEvents,
  userId: string | undefined,
  restoring: boolean,
): void {
  const initialStateSynced = useRef(false);
  useEffect(() => {
    initialStateSynced.current = false;
    if (!platform.notifyWebRemoteControlAuthStateChanged) return;
    const subscription = oauth.onDidChangeSession((state) => {
      // 实时凭据事实优先于迟到的初始 UI 投影；无需在 renderer 保存第二份认证状态。
      initialStateSynced.current = true;
      platform.notifyWebRemoteControlAuthStateChanged?.({ state });
    });
    return () => subscription.dispose();
  }, [platform, oauth]);

  useEffect(() => {
    if (restoring || initialStateSynced.current) return;
    initialStateSynced.current = true;
    platform.notifyWebRemoteControlAuthStateChanged?.({
      state: userId ? "signed-in" : "signed-out",
    });
  }, [platform, oauth, userId, restoring]);
}
