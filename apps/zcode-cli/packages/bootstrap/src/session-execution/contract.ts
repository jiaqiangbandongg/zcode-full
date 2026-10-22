import type { CommandPayloadMap } from "@zcode/shared/zcode-protocol-v4";
import type { SendInputOptions } from "../app/types.js";

/** 原 session record 拥有计数；租约不创建第二个运行态或调度锁。 */
export interface SessionResidencyFinalizationOwner {
  residencyFinalizationCount?: number;
}
export type ModelExecutionInput = NonNullable<CommandPayloadMap["sendText"]["modelExecution"]>;
export type ModelExecutionContext = NonNullable<SendInputOptions["modelExecution"]>;

export interface SessionExecutionContract {
  /** 拷贝并冻结本轮请求鉴权，不持久化凭证。 */
  createModelExecutionContext(input: ModelExecutionInput): ModelExecutionContext;
  /** 同步增加原 record 计数，返回幂等释放函数。 */
  acquireSessionResidencyFinalization(owner: SessionResidencyFinalizationOwner): () => void;
  /** 先持有再执行，成功、失败或同步抛错均释放，不吞掉错误。 */
  runWithSessionResidencyFinalization<T>(
    owner: SessionResidencyFinalizationOwner,
    run: () => Promise<T>,
  ): Promise<T>;
}
