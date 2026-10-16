import { useSyncExternalStore } from "react";
import type { WebRemoteControlTerminalTransportState } from "@/root/types.js";

let currentState: WebRemoteControlTerminalTransportState = "idle";
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): WebRemoteControlTerminalTransportState {
  return currentState;
}

export function setWebRemoteControlTerminalTransportState(
  state: WebRemoteControlTerminalTransportState,
): void {
  if (currentState === state) {
    return;
  }

  currentState = state;
  for (const listener of listeners) {
    listener();
  }
}

export function useWebRemoteControlTerminalTransportState(
  serverSnapshot: WebRemoteControlTerminalTransportState = currentState,
): WebRemoteControlTerminalTransportState {
  // Bugfix: 手机远控 transport 状态可能在 relay 抖动时快速变化。
  // 这里用轻量外部订阅只更新重连提示，避免为了 toast 反复重渲染整棵 Root/App。
  return useSyncExternalStore(subscribe, getSnapshot, () => serverSnapshot);
}
