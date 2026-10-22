import type {
  WebRemoteControlExternalWorkspaceBridge,
  WebRemoteControlMobileTaskView,
  WebRemoteControlMobileTaskViewUpdatePayload,
} from "@zcode/shared";
import type { WebRemoteControlTerminalTransportState } from "#src/web-remote-control/contract.js";

/** 只保留 Reporter 的当前投影供传输恢复重申；任务已读仍由桌面唯一 writer 提交。 */
export function createWebRemoteControlTaskViewPublisher(
  send: (payload: WebRemoteControlMobileTaskViewUpdatePayload) => boolean,
) {
  let bridge: WebRemoteControlExternalWorkspaceBridge | undefined;
  let view: WebRemoteControlMobileTaskView | null = null;
  let epoch: string | undefined;
  let seq = 0;
  let dirty = false;
  const matches = (target: WebRemoteControlExternalWorkspaceBridge) =>
    bridge?.bridgeSessionId === target.bridgeSessionId &&
    bridge?.bridgeGeneration === target.bridgeGeneration;
  const flush = () => {
    if (!bridge || !epoch || !dirty) return;
    dirty = !send({
      zcode_type: "mobile-task-view-update",
      epoch,
      seq: ++seq,
      bridgeSessionId: bridge.bridgeSessionId,
      ...(bridge.bridgeGeneration !== undefined
        ? { bridgeGeneration: bridge.bridgeGeneration }
        : {}),
      view,
    });
  };
  const request = (nextEpoch: string) => {
    if (epoch !== nextEpoch) seq = 0;
    epoch = nextEpoch;
    dirty = true;
    flush();
  };
  const disconnected = () => {
    epoch = undefined;
    dirty = true;
  };
  return {
    request,
    seed(nextEpoch: string | undefined) {
      // 配对请求可能先于 bootstrap 回包；迟到的 bootstrap 不得把更新的 epoch 改回去。
      if (!epoch && nextEpoch) request(nextEpoch);
    },
    disconnected,
    suspend() {
      // lifecycle 监听早于 React Reporter；必须在 transport 停发前撤销，不能等待后装的监听器。
      view = null;
      dirty = true;
      flush();
    },
    transportStateChanged(
      next: WebRemoteControlTerminalTransportState,
      previous: WebRemoteControlTerminalTransportState,
    ) {
      if (next === "paired") {
        flush();
      } else if (next !== "suspended" && !(next === "reconnecting" && previous === "suspended")) {
        // 挂起及原 socket 探测不改变 Main 的 epoch，不能重置 seq；真正鉴权/建连仍需新声明。
        disconnected();
      }
    },
    setBridge(next: WebRemoteControlExternalWorkspaceBridge) {
      if (matches(next)) return;
      bridge = next;
      // 新 bridge 的初始任务只是导航意图，必须等待新 Root 的实际可见 Reporter。
      view = null;
      dirty = true;
      flush();
    },
    update(
      source: WebRemoteControlExternalWorkspaceBridge,
      next: WebRemoteControlMobileTaskView | null,
    ) {
      // 旧 Root 的卸载回调可能晚于新 Root 挂载，不能清掉新 bridge 的可见事实。
      if (!matches(source)) return;
      view = next;
      dirty = true;
      flush();
    },
    flush,
  };
}
