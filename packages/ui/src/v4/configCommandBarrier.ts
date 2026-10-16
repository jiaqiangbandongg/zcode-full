export interface ConfigCommandBarrier {
  enqueue<T>(command: () => Promise<T>): Promise<T>;
  wait(): Promise<void>;
}

export const CONFIG_COMMAND_SUPERSEDED = Symbol("config-command-superseded");

export interface LatestConfigCommandScheduler<T> {
  /**
   * 合并尚未开始的同类配置命令；被新意图替代的调用以 superseded 收敛。
   */
  schedule(
    command: () => Promise<T>,
  ): Promise<T | typeof CONFIG_COMMAND_SUPERSEDED>;
  /**
   * 封住当前等待槽。发送命令入队前调用，保证封住的配置一定排在发送之前，
   * 后续配置则创建新槽并排在发送之后。
   */
  seal(): void;
}

/**
 * 配置命令与发送命令之间的顺序屏障。
 *
 * 模式/模型选择先乐观更新 UI，再异步提交 CAS；用户紧接着发送时，
 * sendText 可能先于 CAS 重试完成，导致界面显示新配置而 runtime 仍使用旧配置。
 */
export function createConfigCommandBarrier(): ConfigCommandBarrier {
  let pending: Promise<void> = Promise.resolve();

  return {
    enqueue<T>(command: () => Promise<T>): Promise<T> {
      const result = pending.then(command, command);
      pending = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    wait(): Promise<void> {
      return pending;
    },
  };
}

/**
 * 在同一顺序屏障上合并“尚未开始”的同类配置命令。
 *
 * Bug 原因：模型/思考深度快速连点会把每一个中间值都排进 stdio CAS 队列；即使 UI
 * 已经是最后一次选择，runtime 仍要逐条处理过时意图。这里只替换未开始的槽，不取消
 * 已经发出的命令；发送前 seal 后，配置 → send 的用户操作顺序仍严格保留。
 */
export function createLatestConfigCommandScheduler<T>(
  barrier: ConfigCommandBarrier,
): LatestConfigCommandScheduler<T> {
  interface Waiter {
    reject: (reason?: unknown) => void;
    resolve: (value: T | typeof CONFIG_COMMAND_SUPERSEDED) => void;
  }
  interface Slot {
    command: () => Promise<T>;
    waiter: Waiter;
  }

  let replaceableSlot: Slot | null = null;

  return {
    schedule(command) {
      return new Promise<T | typeof CONFIG_COMMAND_SUPERSEDED>(
        (resolve, reject) => {
          if (replaceableSlot) {
            replaceableSlot.waiter.resolve(CONFIG_COMMAND_SUPERSEDED);
            replaceableSlot.command = command;
            replaceableSlot.waiter = { reject, resolve };
            return;
          }

          const slot: Slot = {
            command,
            waiter: { reject, resolve },
          };
          replaceableSlot = slot;
          void barrier.enqueue(async () => {
            if (replaceableSlot === slot) {
              replaceableSlot = null;
            }
            const scheduledCommand = slot.command;
            const scheduledWaiter = slot.waiter;
            try {
              scheduledWaiter.resolve(await scheduledCommand());
            } catch (error) {
              scheduledWaiter.reject(error);
            }
          });
        },
      );
    },
    seal() {
      replaceableSlot = null;
    },
  };
}
