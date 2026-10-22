import { createContext, useContext, useMemo, type ReactNode } from "react";
import { parseRemoteWorkspaceIdentity, type SourceServerRecord } from "@zcode/shared";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

type SettingsTarget = Partial<
  Pick<WorkspaceTabState, "workspaceIdentity" | "remoteTarget" | "remoteSessionId">
>;
const SettingsMachinesContext = createContext<readonly SourceServerRecord[]>([]);
const SettingsUserScopeContext = createContext<{
  target?: SettingsTarget | null;
  sourceServerId?: string | null;
}>({});

/** 编辑表单内的作用域菜单沿用所在分区的 user 目标。 */
export function SettingsUserScopeProvider({
  target,
  sourceServerId,
  children,
}: {
  target?: SettingsTarget | null;
  sourceServerId?: string | null;
  children?: ReactNode;
}) {
  const value = useMemo(() => ({ target, sourceServerId }), [target, sourceServerId]);
  return (
    <SettingsUserScopeContext.Provider value={value}>{children}</SettingsUserScopeContext.Provider>
  );
}

export function useSettingsUserScope() {
  return useContext(SettingsUserScopeContext);
}

/** 复用设置页的权威快照，只投影设备名，不创建第二份管理状态。 */
export function SettingsMachinesProvider({
  servers,
  children,
}: {
  servers: readonly SourceServerRecord[];
  children?: ReactNode;
}) {
  return (
    <SettingsMachinesContext.Provider value={servers}>{children}</SettingsMachinesContext.Provider>
  );
}

export function useSettingsMachineLabel() {
  const servers = useContext(SettingsMachinesContext);
  const { intl } = useZCodeIntl();
  return (target?: SettingsTarget | null, sourceServerId?: string | null) => {
    const parsed = parseRemoteWorkspaceIdentity(target?.workspaceIdentity ?? "");
    const sourceId = sourceServerId ?? parsed?.sourceServerId;
    const remote = Boolean(sourceId || target?.remoteTarget || target?.remoteSessionId || parsed);
    const transport = target?.remoteTarget;
    const name =
      servers.find((server) => server.sourceServerId === sourceId)?.displayName ||
      (transport?.kind === "ssh"
        ? transport.host
        : transport?.kind === "docker"
          ? transport.container
          : transport?.kind === "wsl"
            ? transport.distro
            : transport?.kind === "server"
              ? transport.name
              : undefined) ||
      intl.formatMessage({ id: "settings.machine.unknownRemote" });
    return {
      remote,
      label: intl.formatMessage(
        { id: remote ? "settings.machine.remote" : "settings.machine.local" },
        { name },
      ),
    };
  };
}
