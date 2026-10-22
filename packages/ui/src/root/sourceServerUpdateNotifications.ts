import { useCallback, useEffect, useRef } from "react";
import type { ISourceServerManagementService } from "@zcode/services";
import type { RemoteTarget, SourceServerManagementSnapshot } from "@zcode/shared";
import { dismissToast, toast, type ToastOptions } from "@/components/ui/toast.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { findSourceServerUpgradeProfileId } from "@/lib/remoteConnectionWizard.js";
import {
  getSourceServerForceUpdateDescription,
  runSourceServerUpdate,
} from "@/lib/sourceServerUpdateAction.js";
import {
  sourceServerUpdatePreferences,
  sourceServerUpdateKey,
} from "@/lib/sourceServerUpdatePreferences.js";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { logger } from "@/logger.js";

interface NotificationControllerOptions {
  preferences?: Pick<typeof sourceServerUpdatePreferences, "hasSeen" | "markSeen">;
  management: ISourceServerManagementService;
  formatMessage: (id: string, values?: Record<string, string | number>) => string;
  showToast: (message: string, options?: ToastOptions) => unknown;
  dismissToast?: (id: unknown) => void;
  confirmForce?: (profileId: string) => Promise<boolean>;
  onDetails?: (sourceServerId: string) => void;
  onProgress?: (sourceServerId: string) => void;
  onError?: (error: unknown) => void;
  isActive?: () => boolean;
  getConnectionTarget?: () => RemoteTarget | null;
}

type SourceServerUpdateState = SourceServerManagementSnapshot["states"][number];

export interface SourceServerUpdateNotificationController {
  refresh(): void;
  dispose(): void;
}

function resolveSourceDisplayName(
  snapshot: SourceServerManagementSnapshot,
  profileId: string,
  sourceServerId?: string,
): string {
  const server = sourceServerId
    ? snapshot.servers.find((candidate) => candidate.sourceServerId === sourceServerId)
    : undefined;
  if (server?.displayName) return server.displayName;
  const profile = snapshot.profiles.find((candidate) => candidate.profileId === profileId);
  return profile?.displayName ?? profile?.transport ?? "Source Server";
}

function getSourceServerUpdateNotificationKey(state: SourceServerUpdateState): string | null {
  const updateRequired = state.state === "needs-upgrade" && state.updateAvailability === "required";
  if (
    !updateRequired ||
    !state.sourceServerId ||
    !state.currentVersion ||
    !state.availableVersion ||
    !state.upgradeTarget
  ) {
    return null;
  }
  return sourceServerUpdateKey(state.sourceServerId, state.availableVersion);
}

function getEligibleNotificationKey(
  options: NotificationControllerOptions,
  snapshot: SourceServerManagementSnapshot,
  state: SourceServerUpdateState,
): string | null {
  const target = options.getConnectionTarget?.();
  // 向导在发起连接前接管目标；不能等 needs-upgrade 到达后再抑制，否则会先弹出重复操作。
  if (
    target &&
    target.kind !== "server" &&
    findSourceServerUpgradeProfileId(snapshot, target) === state.profileId
  )
    return null;
  return getSourceServerUpdateNotificationKey(state);
}

export function showSourceServerUpdateNotification(
  options: NotificationControllerOptions & {
    snapshot: SourceServerManagementSnapshot;
    state: SourceServerUpdateState;
  },
): { id: unknown } | null {
  const key = getEligibleNotificationKey(options, options.snapshot, options.state);
  if (!key) return null;

  const state = options.state;
  const updateRequired = state.updateAvailability === "required";
  const source = resolveSourceDisplayName(options.snapshot, state.profileId, state.sourceServerId);
  const canUpdateServer = state.upgradeTarget === "server";
  let actionStarted = false;
  const handleUpdate = canUpdateServer
    ? () => {
        if (actionStarted || options.isActive?.() === false) return;
        actionStarted = true;
        let progressToastId: unknown;
        void (async () => {
          // Toast 是过去快照的投影。点击必须复核 Host 状态，不能让过期按钮再次发起更新。
          const snapshot = await options.management.getSnapshot();
          const current = snapshot.states.find(
            (candidate) => candidate.profileId === state.profileId,
          );
          if (
            options.isActive?.() === false ||
            !current ||
            getEligibleNotificationKey(options, snapshot, current) !== key
          )
            return null;
          // 主动更新后定位设备卡，让既有阶段与进度投影立即可见。
          if (state.sourceServerId) options.onProgress?.(state.sourceServerId);
          progressToastId = options.showToast(
            options.formatMessage("sourceServer.updateStartedToast", { source }),
            {
              durationMs: 60_000,
              position: "top-center",
              variant: "info",
              dismissible: true,
              dismissLabel: options.formatMessage("common.close"),
            },
          );
          return await runSourceServerUpdate({
            management: options.management,
            profileId: state.profileId,
            confirmForce: () => options.confirmForce?.(state.profileId) ?? Promise.resolve(false),
          });
        })()
          .then((next) => {
            options.dismissToast?.(progressToastId);
            if (!next || options.isActive?.() === false) return;
            options.showToast(
              options.formatMessage("sourceServer.updateCompletedToast", {
                source,
              }),
              {
                durationMs: 8_000,
                position: "top-center",
                variant: "source-server-update",
                dismissible: true,
                dismissLabel: options.formatMessage("common.close"),
              },
            );
          })
          .catch((error) => {
            options.dismissToast?.(progressToastId);
            if (options.isActive?.() !== false) {
              options.showToast(
                options.formatMessage("sourceServer.updateFailedToast", {
                  source,
                }),
                {
                  durationMs: 10_000,
                  position: "top-center",
                  variant: "warning",
                  actionLabel: options.formatMessage("remote.action.details"),
                  onAction: () => {
                    if (state.sourceServerId) options.onDetails?.(state.sourceServerId);
                  },
                  dismissible: true,
                  dismissLabel: options.formatMessage("common.close"),
                },
              );
            }
            options.onError?.(error);
          });
      }
    : undefined;
  const toastId = options.showToast(
    options.formatMessage(
      canUpdateServer
        ? updateRequired
          ? "sourceServer.updateRequiredToast"
          : "sourceServer.updateAvailableToast"
        : "sourceServer.controllerUpdateAvailableToast",
      {
        source,
        current: state.currentVersion!,
        available: state.availableVersion!,
      },
    ),
    {
      durationMs: 8_000,
      position: "top-center",
      variant: "source-server-update",
      ...(handleUpdate
        ? {
            actionLabel: options.formatMessage("settings.source.updateNow"),
            onAction: handleUpdate,
          }
        : {}),
      dismissible: true,
      dismissLabel: options.formatMessage("common.close"),
    },
  );
  return { id: toastId };
}

export function createSourceServerUpdateNotificationController(
  options: NotificationControllerOptions,
): SourceServerUpdateNotificationController {
  // 活跃 toast 随状态撤销；持久去重独立保留，不被断线、向导接管或重启清除。
  const shown = new Map<string, { id: unknown }>();
  const preferences = options.preferences ?? sourceServerUpdatePreferences;
  let disposed = false;
  let refreshInFlight: Promise<void> | null = null;
  let refreshQueued = false;

  const refresh = () => {
    if (disposed) return;
    if (refreshInFlight) {
      refreshQueued = true;
      return;
    }
    refreshInFlight = options.management
      .getSnapshot()
      .then((snapshot) => {
        if (disposed || refreshQueued) return;
        const eligible = new Map<string, SourceServerUpdateState>();
        for (const state of snapshot.states) {
          const key = getEligibleNotificationKey(options, snapshot, state);
          if (key) eligible.set(key, state);
        }
        // updating/已完成/移除/向导接管时，立即撤销旧提示；不能只跳过新提示、等旧按钮超时。
        for (const [key, notification] of shown) {
          if (eligible.has(key)) continue;
          options.dismissToast?.(notification.id);
          shown.delete(key);
        }
        for (const [key, state] of eligible) {
          if (shown.has(key) || preferences.hasSeen(key)) continue;
          const notification = showSourceServerUpdateNotification({
            ...options,
            snapshot,
            state,
            isActive: () => !disposed,
          });
          if (notification) {
            shown.set(key, notification);
            preferences.markSeen(key);
          }
        }
      })
      .catch((error) => options.onError?.(error))
      .finally(() => {
        refreshInFlight = null;
        if (refreshQueued && !disposed) {
          refreshQueued = false;
          refresh();
        }
      });
  };

  const stateSubscription = options.management.onDidChangeState(refresh);
  const directorySubscription = options.management.onDidChangeDirectory?.(refresh);
  refresh();
  return {
    refresh,
    dispose() {
      disposed = true;
      stateSubscription.dispose();
      directorySubscription?.dispose();
      for (const notification of shown.values()) options.dismissToast?.(notification.id);
      shown.clear();
    },
  };
}

export function useSourceServerUpdateNotifications(options: {
  enabled: boolean;
  management?: ISourceServerManagementService;
}): (target: RemoteTarget | null) => void {
  const connectionTargetRef = useRef<RemoteTarget | null>(null);
  const controllerRef = useRef<SourceServerUpdateNotificationController | null>(null);
  const handleConnectionTargetChange = useCallback((target: RemoteTarget | null) => {
    connectionTargetRef.current = target;
    controllerRef.current?.refresh();
  }, []);
  const { intl } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const openSettingsTab = useTabStore((state) => state.openSettingsTab);
  useEffect(() => {
    if (!options.enabled || !options.management) return undefined;
    const controller = createSourceServerUpdateNotificationController({
      management: options.management,
      getConnectionTarget: () => connectionTargetRef.current,
      formatMessage: (id, values) => intl.formatMessage({ id }, values),
      showToast: toast,
      dismissToast: (id) => {
        if (typeof id === "number") dismissToast(id);
      },
      onDetails: (sourceServerId) => {
        setPendingSettingsSectionIntent("remoteDevices", {
          sourceServerId,
          sourceServerDetails: true,
        });
        openSettingsTab();
      },
      onProgress: (sourceServerId) => {
        setPendingSettingsSectionIntent("remoteDevices", { sourceServerId });
        openSettingsTab();
      },
      confirmForce: async (profileId) =>
        await confirmDialog({
          title: intl.formatMessage({
            id: "settings.source.forceUpdateTitle",
          }),
          description: await getSourceServerForceUpdateDescription(
            options.management!,
            profileId,
            (id) => intl.formatMessage({ id }),
          ),
          confirmLabel: intl.formatMessage({
            id: "settings.source.forceUpdate",
          }),
          confirmVariant: "destructive",
        }),
      onError: (error) =>
        logger.warn("[sourceServerUpdateNotifications] 读取 Source 版本状态失败", {
          error: error instanceof Error ? error.message : String(error),
        }),
    });
    controllerRef.current = controller;
    return () => {
      controllerRef.current = null;
      controller.dispose();
    };
  }, [confirmDialog, intl, openSettingsTab, options.enabled, options.management]);
  return handleConnectionTargetChange;
}
