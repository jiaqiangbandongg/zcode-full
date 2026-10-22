import { useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { AgentPointer, LoadedDoc, Picked } from "#ui/shell/state.ts";
import type { DrawerTab } from "#ui/shell/panes.tsx";
import type { PageState, ViewerHandle } from "#ui/viewers/types.ts";

/**
 * 面板快捷键：⌘F、⌘Enter、⌘± / ⌘0、翻页键，以及 Esc 逐层关闭最上层界面。
 * 从 main.tsx 的 Shell 拆出以控制单文件规模，行为与依赖项与拆分前一致。
 */
export function useShellKeys({
  docRef,
  viewer,
  picked,
  addReference,
  openFind,
  closeFind,
  clearSelection,
  paged,
  page,
  goToPage,
  drawer,
  setDrawer,
  docked,
  find,
  agent,
  setAgent,
}: {
  docRef: RefObject<LoadedDoc | null>;
  viewer: RefObject<ViewerHandle | null>;
  picked: Picked | null;
  addReference(): Promise<void>;
  openFind(): void;
  closeFind(): void;
  clearSelection(): void;
  paged: boolean;
  page: PageState | null;
  goToPage(n: number): void;
  drawer: { open: boolean; tab: DrawerTab };
  setDrawer: Dispatch<SetStateAction<{ open: boolean; tab: DrawerTab }>>;
  docked: boolean;
  find: { open: boolean };
  agent: AgentPointer | null;
  setAgent: Dispatch<SetStateAction<AgentPointer | null>>;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const mod = event.metaKey || event.ctrlKey;
      const typing = (event.target as Element)?.closest?.("input, textarea, [contenteditable]");
      const key = event.key.toLowerCase();
      if (mod && key === "f" && docRef.current) {
        event.preventDefault();
        openFind();
      } else if (mod && event.key === "Enter" && picked) {
        event.preventDefault();
        void addReference();
      } else if (mod && (event.key === "=" || event.key === "+")) {
        event.preventDefault();
        viewer.current?.zoom(1);
      } else if (mod && event.key === "-") {
        event.preventDefault();
        viewer.current?.zoom(-1);
      } else if (mod && event.key === "0") {
        event.preventDefault();
        viewer.current?.fit("width");
      } else if (
        !mod &&
        !typing &&
        paged &&
        page &&
        ["ArrowLeft", "ArrowRight", "PageUp", "PageDown"].includes(event.key)
      ) {
        event.preventDefault();
        const back = event.key === "ArrowLeft" || event.key === "PageUp";
        goToPage(page.current + (back ? -1 : 1));
      } else if (event.key === "Escape" && !typing) {
        if (picked) clearSelection();
        else if (drawer.open && !docked) setDrawer((state) => ({ ...state, open: false }));
        else if (find.open) closeFind();
        else if (agent?.visible) setAgent({ ...agent, visible: false });
        else return;
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    picked,
    addReference,
    openFind,
    closeFind,
    clearSelection,
    paged,
    page,
    goToPage,
    drawer.open,
    docked,
    find.open,
    agent,
    docRef,
    viewer,
    setDrawer,
    setAgent,
  ]);
}
