import { useCallback, useEffect, useRef, useState } from "react";
import type { SourceServerManagementSnapshot } from "@zcode/shared";
import type { ISourceServerManagementService } from "@zcode/services";

export function useSourceServerManagementSnapshot(
  management: ISourceServerManagementService | undefined,
  options: {
    enabled?: boolean;
    onError?: (error: unknown) => void;
  } = {},
): {
  snapshot: SourceServerManagementSnapshot | null;
  ready: boolean;
  applySnapshot: (snapshot: SourceServerManagementSnapshot) => void;
  refresh: () => void;
} {
  const enabled = options.enabled ?? true;
  const onErrorRef = useRef(options.onError);
  onErrorRef.current = options.onError;
  const observedGenerationRef = useRef(-1);
  const [snapshot, setSnapshot] =
    useState<SourceServerManagementSnapshot | null>(null);
  const [ready, setReady] = useState(false);
  const refreshRef = useRef<() => void>(() => undefined);

  const applySnapshot = useCallback((next: SourceServerManagementSnapshot) => {
    if (next.generation < observedGenerationRef.current) return;
    observedGenerationRef.current = next.generation;
    setSnapshot(next);
    setReady(true);
  }, []);

  useEffect(() => {
    if (!management || !enabled) {
      observedGenerationRef.current = -1;
      setSnapshot(null);
      setReady(false);
      refreshRef.current = () => undefined;
      return undefined;
    }
    let disposed = false;
    let refreshInFlight: Promise<void> | null = null;
    let refreshQueued = false;
    let migrationRefreshQueued = false;
    const refresh = (refreshMigrationCounts = false): void => {
      if (refreshInFlight) {
        refreshQueued = true;
        migrationRefreshQueued ||= refreshMigrationCounts;
        return;
      }
      refreshInFlight = management
        .getSnapshot({ refreshMigrationCounts })
        .then((next) => {
          if (!disposed) applySnapshot(next);
        })
        .catch((error) => {
          if (disposed) return;
          setReady(false);
          onErrorRef.current?.(error);
        })
        .finally(() => {
          refreshInFlight = null;
          if (!disposed && refreshQueued) {
            refreshQueued = false;
            const refreshCounts = migrationRefreshQueued;
            migrationRefreshQueued = false;
            refresh(refreshCounts);
          }
        });
    };
    // 统计完成也会触发目录事件；只有显式进入/刷新页面才主动重读，避免事件反馈形成轮询。
    refreshRef.current = () => refresh(true);
    refresh(true);
    const stateSubscription = management.onDidChangeState(() => refresh());
    const directorySubscription = management.onDidChangeDirectory?.(() =>
      refresh(),
    );
    return () => {
      disposed = true;
      refreshRef.current = () => undefined;
      stateSubscription.dispose();
      directorySubscription?.dispose();
    };
  }, [applySnapshot, enabled, management]);

  return {
    snapshot,
    ready,
    applySnapshot,
    refresh: useCallback(() => refreshRef.current(), []),
  };
}
