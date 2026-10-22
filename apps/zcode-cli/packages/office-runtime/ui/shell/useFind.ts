import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { ViewerHandle } from "#ui/viewers/types.ts";

export interface FindState {
  open: boolean;
  query: string;
  total: number | null;
  index: number;
}

export const CLOSED_FIND: FindState = { open: false, query: "", total: null, index: -1 };

/**
 * 面板内查找：输入即搜，Enter / ⇧Enter 在结果间跳转。
 * 从 main.tsx 的 Shell 拆出以控制单文件规模，行为与拆分前一致；setFind 仍交给 Shell，
 * 供载入新文档和 Agent 定位时直接关闭查找。
 */
export function useFind({
  viewer,
  docRef,
  ready,
  onOpen,
}: {
  viewer: RefObject<ViewerHandle | null>;
  docRef: RefObject<unknown>;
  ready: boolean;
  /** 打开查找前清理与查找互斥的界面状态（选区、Agent 标记、菜单）。 */
  onOpen(): void;
}) {
  const [find, setFind] = useState<FindState>(CLOSED_FIND);
  const findSeq = useRef(0);

  const openFind = useCallback(() => {
    if (!docRef.current) return;
    onOpen();
    setFind((state) => ({ ...state, open: true }));
    // Re-focus when already open.
    requestAnimationFrame(() => {
      const input = document.querySelector<HTMLInputElement>(".findbar .find-input");
      input?.focus();
      input?.select();
    });
  }, [docRef, onOpen]);
  const closeFind = useCallback(() => {
    findSeq.current++;
    viewer.current?.clearFind();
    setFind(CLOSED_FIND);
  }, [viewer]);
  const queryFind = useCallback((query: string) => {
    setFind((state) => ({ ...state, query, total: query.trim() ? state.total : null }));
  }, []);
  useEffect(() => {
    if (!find.open || !ready) return;
    const mine = ++findSeq.current;
    const timer = setTimeout(async () => {
      const handle = viewer.current;
      if (!handle) return;
      const total = await handle.find(find.query).catch(() => 0);
      if (mine !== findSeq.current) return;
      setFind((state) => ({ ...state, total, index: total ? 0 : -1 }));
      if (total) handle.findGo(0);
    }, 200);
    return () => clearTimeout(timer);
  }, [find.open, find.query, ready, viewer]);
  const stepFind = useCallback(
    (direction: 1 | -1) => {
      if (!find.total) return;
      const index = (find.index + direction + find.total) % find.total;
      setFind((state) => ({ ...state, index }));
      viewer.current?.findGo(index);
    },
    [find.total, find.index, viewer],
  );

  return { find, setFind, openFind, closeFind, queryFind, stepFind };
}
