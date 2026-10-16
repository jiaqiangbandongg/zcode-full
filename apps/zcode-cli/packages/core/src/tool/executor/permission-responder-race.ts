// PermissionRequest hook 链与交互 broker 的并发竞速。
//
// 旧路径在 emitPermissionRequested 之后串行 await hook
// 链，broker 的应答 deferred 要等 hook 返回才注册。同步 hook（把权限请求转投外部 UI 并
// 阻塞等待外部点击的桥接程序）挂起期间，确认窗已对用户可见，但所有点击都被
// resolveInteraction 按「未命中即幂等成功」丢弃——确认窗永久死亡，turn 永久挂起。
// 修法：两个应答方并发启动、先到的决定生效、败者立即 abort 且不被等待。
import type { PermissionBrokerResult } from "@zcode/contracts";
import { linkAbortSignal } from "./timeout.js";

export interface PermissionResponderRaceInput {
  /**
   * hook 链应答方。resolve `undefined` 表示无决定（退赛，只剩 broker 单边等待）；
   * 抛错同样按退赛处理并回调 {@link PermissionResponderRaceInput.onHookFailure}——
   * 辅助应答方的基础设施故障不应替用户做拒绝决定。
   */
  runHooks: (signal: AbortSignal) => Promise<PermissionBrokerResult | undefined>;
  /**
   * broker 应答方。应答通道（v4 interaction deferred / TUI 审批队列）必须在本函数
   * 调用内同步建立——这是确认窗「可见即可答」的前提，由既有 broker 契约保证。
   * 拒绝（超时、取消、fail-closed）在 hook 未胜出时原样上抛，错误形态与旧串行路径一致。
   */
  requestBroker: (
    signal: AbortSignal,
    claimResponse: () => boolean,
  ) => Promise<PermissionBrokerResult>;
  /** 外层 turn 取消信号：abort 双方，随后 broker 的拒绝按上一条上抛。 */
  signal?: AbortSignal;
  /** hook 链抛错且竞速尚未收口时回调（调用方记 warn 日志）。 */
  onHookFailure?: (error: unknown) => void;
}

export interface PermissionResponderRaceOutcome {
  result: PermissionBrokerResult;
  source: "hook" | "broker";
}

export async function racePermissionResponders(
  input: PermissionResponderRaceInput,
): Promise<PermissionResponderRaceOutcome> {
  const hookController = new AbortController();
  const brokerController = new AbortController();
  const unlinkHook = linkAbortSignal(input.signal, hookController);
  const unlinkBroker = linkAbortSignal(input.signal, brokerController);

  let settled = false;
  let brokerClaimed = false;
  try {
    return await new Promise<PermissionResponderRaceOutcome>((resolve, reject) => {
      const settle = (action: () => void, abortLoser: AbortController) => {
        if (settled) return;
        settled = true;
        action();
        // 先兑现结果再 abort 败者：败者的收尾（子进程终止、反向 RPC 取消）绝不能
        // 反过来阻塞胜者——挂死的就是败者本身。
        abortLoser.abort();
      };

      // broker 先启动：requestPermission 内同步注册应答 deferred，保证确认窗一可见
      // 用户点击就有归宿，不给 hook 留任何独占窗口期。
      input
        .requestBroker(brokerController.signal, () => {
          if (settled || brokerController.signal.aborted) return false;
          brokerClaimed = true;
          hookController.abort();
          return true;
        })
        .then(
          (result) => settle(() => resolve({ result, source: "broker" }), hookController),
          (error) => {
            // hook 胜出后我们主动 abort broker 产生的拒绝是自己的取消，吞掉；
            // 竞速未收口时的拒绝（超时/外层取消/fail-closed）是真实错误，原样上抛。
            settle(() => reject(error), hookController);
          },
        );

      input.runHooks(hookController.signal).then(
        (decision) => {
          // 无决定 = 退赛：不迁移竞速状态，broker 继续单边等待。
          if (decision === undefined || brokerClaimed) return;
          settle(() => resolve({ result: decision, source: "hook" }), brokerController);
        },
        (error) => {
          if (settled) return;
          input.onHookFailure?.(error);
        },
      );
    });
  } finally {
    unlinkHook();
    unlinkBroker();
  }
}
