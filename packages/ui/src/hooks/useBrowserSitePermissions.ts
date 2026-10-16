import { useCallback, useEffect, useRef, useState } from "react";
import type { EmbeddedBrowserSitePermissionsSnapshot } from "@zcode/shared";
import { usePlatform } from "@/hooks/usePlatform.js";
import { logger } from "@/logger.js";

type WriteOperation =
  | { kind: "set"; permission: string; state: "allow" | "deny" | "ask" }
  | { kind: "reset" };
type WriteState =
  | { status: "idle" }
  | { status: "pending" | "failed" | "succeeded"; operation: WriteOperation };

/** main 站点权限 store 是唯一授权状态源；hook 只持有读取投影和用户操作的进度。 */
export function useBrowserSitePermissions(origin: string, enabled: boolean) {
  const platform = usePlatform();
  const [states, setStates] = useState<Record<string, "allow" | "deny"> | null>(null);
  const [error, setError] = useState(false);
  const [writeState, setWrite] = useState<WriteState>({ status: "idle" });
  const pendingWrite = useRef<WriteOperation | null>(null);
  const generation = useRef(0);
  const supported =
    !!platform.getEmbeddedBrowserSitePermissions &&
    !!platform.setEmbeddedBrowserSitePermission &&
    !!platform.resetEmbeddedBrowserSitePermission;

  useEffect(() => {
    setWrite({ status: "idle" });
    // 隐藏标签不取消已提交写入；只有目标站点/平台更换或卸载才让旧操作失去 UI 归属。
    return () => {
      pendingWrite.current = null;
    };
  }, [origin, platform]);

  const refresh = useCallback(async () => {
    if (!enabled || !platform.getEmbeddedBrowserSitePermissions) return;
    const current = ++generation.current;
    try {
      const snapshot: EmbeddedBrowserSitePermissionsSnapshot =
        await platform.getEmbeddedBrowserSitePermissions();
      if (current !== generation.current) return;
      setStates(snapshot[origin] ?? {});
      setError(false);
    } catch (cause) {
      if (current !== generation.current) return;
      setError(true);
      logger.warn("[browser-permissions] settings read failed", cause);
    }
  }, [enabled, origin, platform]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    return () => {
      generation.current++;
    };
  }, [enabled, origin, platform, refresh]);

  async function run(operation: WriteOperation) {
    if (!enabled || !supported || pendingWrite.current) return;
    // React 状态尚未渲染时也只接受一次点击；该引用同时标识异步完成所属的操作。
    pendingWrite.current = operation;
    setWrite({ status: "pending", operation });
    try {
      if (operation.kind === "reset") {
        await platform.resetEmbeddedBrowserSitePermission!({ origin });
      } else {
        await platform.setEmbeddedBrowserSitePermission!({
          origin,
          permission: operation.permission,
          state: operation.state,
        });
      }
    } catch (cause) {
      logger.warn("[browser-permissions] settings write failed", cause);
      if (pendingWrite.current === operation) {
        pendingWrite.current = null;
        setWrite({ status: "failed", operation });
      }
      return;
    }
    if (pendingWrite.current !== operation) return;
    // 写入和重读的失败属于不同操作。已成功写入不能因读取失败被再次提交。
    await refresh();
    if (pendingWrite.current !== operation) return;
    pendingWrite.current = null;
    setWrite({ status: "succeeded", operation });
  }

  return {
    states,
    error,
    refresh,
    supported,
    write: writeState,
    setPermission: (permission: string, setting: "ask" | "allow" | "block") =>
      run({ kind: "set", permission, state: setting === "block" ? "deny" : setting }),
    reset: () => run({ kind: "reset" }),
    retryWrite: async () => {
      if (writeState.status === "failed") await run(writeState.operation);
    },
  };
}
