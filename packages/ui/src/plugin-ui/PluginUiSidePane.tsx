import { memo, useMemo } from "react";
import type { PluginUiScopeRef } from "@zcode/shared/mcp-apps";
import { readPluginUiScopeRef, type PluginUiSidePaneTab } from "@/plugin-ui/contract.js";
import {
  PluginUiConversationScope,
  usePluginUiSidePaneModel,
} from "@/plugin-ui/adapters/usePluginUiSidePaneModel.js";
import { PluginUiSidePaneView } from "@/plugin-ui/components/PluginUiSidePane.js";

type Props = {
  tab: PluginUiSidePaneTab;
  onOpenBrowserUrl?: (url: string) => void;
  /** 页面请求回到 inline 时宿主关闭本 tab。 */
  onCloseTab?: (tabId: string) => void;
};
function Content(props: Props & { scopeRef: PluginUiScopeRef }) {
  return <PluginUiSidePaneView {...usePluginUiSidePaneModel(props)} />;
}

/** 模块组装入口：将只读会话适配器与纯视图连接。 */
export const PluginUiSidePane = memo(function PluginUiSidePane(props: Props) {
  const scopeRef = useMemo(
    () => readPluginUiScopeRef(props.tab),
    [props.tab.surfaceId, props.tab.toolCallId],
  );
  if (!scopeRef) return null;
  return (
    <PluginUiConversationScope tab={props.tab}>
      <Content {...props} scopeRef={scopeRef} />
    </PluginUiConversationScope>
  );
});
