import type { RemoteConnectionOpenPreference } from "@/app-shell/types.js";
import type { RemoteConnectionPresentation } from "@/lib/remoteConnectionPresentation.js";
import { resolveRemoteConnectionPresentation } from "@/lib/remoteConnectionPresentation.js";
import type { ReconnectRemoteWorkspaceOptions } from "@/root/reconnectRemoteWorkspaceHistoryEntry.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import {
  getSourceServerUpdateTarget,
  hostRemoteWorkspaceConnectFailedResponseSchema,
} from "@zcode/shared";

/** 只分派用户意图；连接状态、失败和日志仍归 Root/Host，向导仅接管需要交互的流程。 */
export async function requestRemoteProjectConnection({
  preference,
  presentation,
  failure,
  reconnect,
  openWizard,
  isCurrent = () => true,
}: {
  preference: RemoteConnectionOpenPreference;
  presentation: RemoteConnectionPresentation;
  failure?: RemoteConnectionOpenPreference["initialFailure"];
  reconnect: (options: ReconnectRemoteWorkspaceOptions) => Promise<void>;
  openWizard: (preference: RemoteConnectionOpenPreference) => void;
  isCurrent?: () => boolean;
}) {
  if (!isCurrent()) return;
  const target = preference.preferredTarget;
  // 原项目等待 reconnect 期间 Profile 可被编辑；交接必须携带等待前的目标，不能重新选址。
  const failedTarget =
    target &&
    target.kind !== "server" &&
    (target.kind !== "wsl" || (target.distro?.trim() && target.user?.trim()))
      ? getSourceServerUpdateTarget(target)
      : undefined;
  if (presentation.status === "failed" || presentation.status === "pending") {
    const waitingCode: Partial<Record<RemoteConnectionPresentation["primaryAction"], string>> = {
      install: "source-server-install-required",
      "update-server": "source-server-upgrade-required",
      "update-desktop": "source-server-upgrade-required",
      "confirm-identity": "source-server-identity-change-pending",
      credentials: "credentials-required",
    };
    const code = failure?.code ?? waitingCode[presentation.primaryAction];
    openWizard({
      ...preference,
      initialFailure: {
        message: failure?.message ?? "",
        ...(code === "source-server-upgrade-required" && failedTarget ? { failedTarget } : {}),
        ...failure,
        code,
      },
    });
    return;
  }
  try {
    await reconnect({
      activateWorkspaceAfterReconnect: false,
      showErrorToast: false,
      throwOnFailure: true,
      requireStoredCredentials: true,
    });
  } catch (error) {
    if (!isCurrent()) return;
    const code =
      error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
    if (
      resolveRemoteConnectionPresentation({ errorCode: code, error: getErrorMessage(error) })
        .status === "pending"
    ) {
      const profileId =
        error &&
        typeof error === "object" &&
        "profileId" in error &&
        typeof error.profileId === "string"
          ? error.profileId
          : undefined;
      const resolvedWslTarget =
        hostRemoteWorkspaceConnectFailedResponseSchema.shape.resolvedWslTarget.safeParse(
          (code === "source-server-install-required" ||
            code === "source-server-upgrade-required") &&
            error &&
            typeof error === "object" &&
            "resolvedWslTarget" in error
            ? error.resolvedWslTarget
            : undefined,
        );
      openWizard({
        ...preference,
        initialFailure: {
          code,
          message: getErrorMessage(error),
          ...(profileId ? { profileId } : {}),
          ...(code === "source-server-upgrade-required" && failedTarget ? { failedTarget } : {}),
          ...(resolvedWslTarget.success && resolvedWslTarget.data
            ? {
                resolvedWslTarget: resolvedWslTarget.data,
                ...(code === "source-server-upgrade-required"
                  ? { failedTarget: getSourceServerUpdateTarget(resolvedWslTarget.data) }
                  : {}),
              }
            : {}),
        },
      });
    }
    // 普通失败已由重连 owner 写回项目行；用户查看前不弹窗，也不再发起请求。
  }
}
