import { resolveWorkspaceKey } from "@zcode/shared";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { useRemoteProjectConnectionPresentation } from "@/project-sidebar/useRemoteProjectConnectionPresentation.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { RemoteConnectionStateIcon } from "@/remote-connection/RemoteConnectionStateIcon.js";
import { cn } from "@/components/lib/utils.js";

function OfflineRemoteProjectRow({
  tab,
  onReconnect,
}: {
  tab: WorkspaceTabState;
  onReconnect: (workspaceKey: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const { presentation, busy, deviceName } = useRemoteProjectConnectionPresentation(tab);
  return (
    <button
      type="button"
      data-offline-project={resolveWorkspaceKey(tab)}
      disabled={busy}
      onClick={() => onReconnect(resolveWorkspaceKey(tab))}
      className={cn(
        "flex w-full min-w-0 items-center gap-2 rounded-lg px-3 py-2 text-left text-ui-sm hover:bg-surface-hover disabled:cursor-wait",
        presentation.foreground,
      )}
    >
      <RemoteConnectionStateIcon presentation={presentation} />
      <span className="min-w-0 flex-1 truncate">
        {tab.label} · {deviceName}
      </span>
      <span>
        {intl.formatMessage({ id: presentation.shortMessageId })}
        {!busy ? ` · ${intl.formatMessage({ id: "remote.action.connect" })}` : null}
      </span>
    </button>
  );
}

/** 四种任务视图共用项目占位，不在这里保存或展示离线任务缓存。 */
export function OfflineRemoteProjectRows({
  workspaceTabs,
  onReconnect,
  section = "tasks",
}: {
  workspaceTabs: WorkspaceTabState[];
  section?: string;
  onReconnect: (workspaceKey: string) => void;
}) {
  return (
    <div data-offline-project-section={section}>
      {workspaceTabs.map((tab) => (
        <OfflineRemoteProjectRow
          key={resolveWorkspaceKey(tab)}
          tab={tab}
          onReconnect={onReconnect}
        />
      ))}
    </div>
  );
}
