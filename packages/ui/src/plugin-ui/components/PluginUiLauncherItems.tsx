import { PuzzleIcon } from "lucide-react";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { OpenPluginUiSideTabRequest } from "@/plugin-ui/contract.js";
import {
  resolvePluginUiSurfaceTitle,
  usePluginUiSurfaces,
} from "@/plugin-ui/adapters/usePluginUiSurfaces.js";

export interface PluginUiLauncherItemsProps {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  /** 正式会话 id；草稿态为 null，此时不显示入口（面板是会话级，第一版不支持草稿）。 */
  sessionId: string | null;
  onOpenPluginUi: (request: OpenPluginUiSideTabRequest) => void;
  /** 菜单复用标准菜单项；空白页继续使用入口按钮样式。 */
  variant?: "launcher" | "menu";
  itemClassName?: string;
}

export function buildPluginUiLauncherItemId(pluginId: string, surfaceId: string): string {
  return `plugin-ui:${pluginId}/${surfaceId}`;
}

/**
 * "打开标签页"里的插件面板入口，与内建项共用列表/网格。
 * 旧分组容器会占据一个网格单元，导致插件全部挤在同一列；使用 Fragment 让按钮直接参与父级布局。
 */
export function PluginUiLauncherItems(props: PluginUiLauncherItemsProps) {
  const { locale } = useZCodeIntl();
  const surfaces = usePluginUiSurfaces({
    workspacePath: props.workspacePath,
    ...(props.workspaceIdentity ? { workspaceIdentity: props.workspaceIdentity } : {}),
    enabled: props.sessionId !== null,
  });
  if (props.sessionId === null || surfaces.length === 0) return null;
  const sessionId = props.sessionId;
  return (
    <>
      {surfaces.map((surface) => {
        const title = resolvePluginUiSurfaceTitle(surface.title, locale) || surface.id;
        const itemId = buildPluginUiLauncherItemId(surface.pluginId, surface.id);
        const open = () =>
          props.onOpenPluginUi({
            parentSessionId: sessionId,
            surfaceId: surface.id,
            serverName: surface.server,
            pluginId: surface.pluginId,
            resourceUri: surface.resourceUri,
            title,
            workspacePath: props.workspacePath,
            ...(props.workspaceIdentity ? { workspaceIdentity: props.workspaceIdentity } : {}),
            remoteSessionId: props.remoteSessionId ?? null,
          });
        if (props.variant === "menu") {
          return (
            <DropdownMenuItem key={itemId} data-side-pane-add-item={itemId} onSelect={open}>
              <PuzzleIcon className="size-4 text-foreground-subtle" />
              <span className="min-w-0 truncate">{title}</span>
            </DropdownMenuItem>
          );
        }
        return (
          <button
            key={itemId}
            type="button"
            data-side-pane-open-tab-item={itemId}
            className={props.itemClassName}
            onClick={open}
          >
            <PuzzleIcon className="size-4 text-foreground-subtle" />
            <span className="side-pane-open-tab-button-label min-w-0 flex-1 truncate text-left">
              {title}
            </span>
            <span className="truncate text-ui-sm text-foreground-subtlest">
              {surface.pluginName}
            </span>
          </button>
        );
      })}
    </>
  );
}
