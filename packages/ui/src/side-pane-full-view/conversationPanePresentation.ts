// 对话 pane 的展示形态（spec：docs/ui/side-pane-full-view.md）。
// Side Pane 完整视图把同一个 SessionPane 实例摆成浮窗时，由壳层宿主提供 floating；
// 其他位置（普通视图、侧栏 tab 里的辅助对话）读到默认值 docked，行为不变。
import { createContext, useContext } from "react";
import type { ConversationPanePresentationValue } from "@/side-pane-full-view/contract.js";

const noop = () => {};

const DOCKED_PRESENTATION: ConversationPanePresentationValue = {
  presentation: "docked",
  reportFloatingStatus: noop,
  reportComposerDockHeight: noop,
};

export const ConversationPanePresentationContext =
  createContext<ConversationPanePresentationValue>(DOCKED_PRESENTATION);

export function useConversationPanePresentation(): ConversationPanePresentationValue {
  return useContext(ConversationPanePresentationContext);
}
