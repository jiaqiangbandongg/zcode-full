import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useOptionalPlatform } from "./usePlatform.js";
import {
  useOptionalBaseWorkspaceServices,
  useWorkspaceServicesResolution,
} from "./useWorkspaceServices.js";
import { acquireGenUiPage, type GenUiCardTarget, type RetainedGenUiPage } from "@/gen-ui/host.js";
export function useGenUi(
  target: GenUiCardTarget,
  confirm: (prompt: string) => Promise<string | null>,
  retry: number,
) {
  const platformService = useOptionalPlatform();
  const platform = platformService?.pluginSandbox;
  const services = useOptionalBaseWorkspaceServices();
  const state = services?.genUiService;
  const resolution = useWorkspaceServicesResolution(
    target.workspacePath,
    target.remoteSessionId,
    target.workspaceIdentity,
  );
  const files = resolution.services.genUiService;
  const [result, setResult] = useState<{
    key: string;
    page: RetainedGenUiPage | null;
    error?: string;
  }>({ key: "", page: null });
  const targetRef = useRef(target);
  targetRef.current = target;
  const key = JSON.stringify(target);
  useEffect(() => {
    if (!platformService || !platform || !state || !files || !resolution.rpcReady) {
      setResult({ key, page: null });
      return;
    }
    let cancelled = false;
    const currentTarget = targetRef.current;
    void acquireGenUiPage({
      target: currentTarget,
      platform,
      state,
      files,
      openExternal: (url) => platformService.openExternal(url),
      watchTaskRemoved(run) {
        const subscription = services?.zcodeTaskService?.onDynamicWorkspaceEvent({
          workspacePath: currentTarget.workspacePath,
          workspaceIdentity: currentTarget.workspaceIdentity,
        })((event) => {
          if (
            event.type === "workspace_task_list_changed" &&
            event.reason === "task_deleted" &&
            event.taskId === currentTarget.sessionId
          )
            run();
        });
        return () => subscription?.dispose();
      },
    }).then(
      (owner) => {
        if (!cancelled) {
          if (retry && owner.getSnapshot().phase === "error") owner.retry();
          setResult({ key, page: owner });
        }
      },
      (error) => {
        if (!cancelled) setResult({ key, page: null, error: String(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, platformService, platform, state, files, services, retry, resolution.rpcReady]);
  const page = key === result.key ? result.page : null;
  useLayoutEffect(() => page?.attachConfirmation(confirm), [page, confirm]);
  return {
    page,
    error: key === result.key ? result.error : undefined,
    supported: Boolean(platform),
    online: resolution.rpcReady,
  };
}
