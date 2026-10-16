import { create } from "zustand";
import type { EmbeddedBrowserPermissionPromptEvent } from "@zcode/shared";

/**
 * 内置浏览器权限弹窗队列：main 经 IPC 推送请求，用户操作后由组件回传决策并出队。
 * main 侧已做同 origin+权限去重与 10s 超时，这里只负责渲染期排队。
 */
interface EmbeddedBrowserPermissionState {
  prompts: EmbeddedBrowserPermissionPromptEvent[];
  receivePrompt: (event: EmbeddedBrowserPermissionPromptEvent) => void;
  /** 同一 requestId 被 main 超时结算后，renderer 侧同步出队（下一次推送不受影响）。 */
  dropPrompt: (requestId: string) => void;
}

export const useEmbeddedBrowserPermissionStore = create<EmbeddedBrowserPermissionState>((set) => ({
  prompts: [],
  // 同 requestId 的推送是列表热更新（蓝牙扫描/USB 枚举连续 fire），替换而非追加。
  receivePrompt: (event) =>
    set((state) => ({
      prompts: state.prompts.some((prompt) => prompt.requestId === event.requestId)
        ? state.prompts.map((prompt) => (prompt.requestId === event.requestId ? event : prompt))
        : [...state.prompts, event],
    })),
  dropPrompt: (requestId) =>
    set((state) => ({ prompts: state.prompts.filter((prompt) => prompt.requestId !== requestId) })),
}));
