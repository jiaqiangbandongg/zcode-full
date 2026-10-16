import type {
  HighspeedCardSnapshot,
  HighspeedMessageMeta,
  HighspeedPrepareTurnResult,
  ModelSelection,
} from "@zcode/shared";
import type { CommandPayloadMap } from "@zcode/shared/zcode-protocol-v4";

/** 与协议 payload 同源，避免 Renderer 再维护一份执行材料形状。 */
type HighspeedModelExecution = NonNullable<CommandPayloadMap["sendText"]["modelExecution"]>;

export type HighspeedTurnPreparer = (
  taskId: string,
  submissionSelection?: ModelSelection,
) => Promise<HighspeedPrepareTurnResult | null>;

/** 会话投影/草稿里可参与 Highspeed prepare 选择解析的字段（结构兼容 snapshot config）。 */
export interface HighspeedPrepareSelectionSource {
  readonly provider?: string;
  readonly model?: string;
  readonly thought?: string;
  readonly modelSelection?: ModelSelection;
}

/**
 * 解析 Highspeed prepare 的 provider/model/reasoningLevel（spec §3 规则 15）：
 * 与本次提交的 modelSelection 同源——用户刚切换的模型必须在首次发送就驱动 admission，
 * 禁止沿用会话投影里的旧组合抽卡后把提交选择覆盖成卡模型。提交选择缺失时按
 * 会话投影 → 草稿 → 初始草稿逐字段回落；provider 或 model 无法解析时返回 null。
 */
export function resolveHighspeedPrepareSelection(input: {
  submissionSelection?: ModelSelection;
  projectedConfig?: HighspeedPrepareSelectionSource | null;
  draftConfig?: HighspeedPrepareSelectionSource | null;
  initialDraftConfig?: HighspeedPrepareSelectionSource | null;
}): { provider: string; model: string; reasoningLevel?: string } | null {
  const { submissionSelection } = input;
  const fallbacks = [input.projectedConfig, input.draftConfig, input.initialDraftConfig];
  const provider = submissionSelection?.providerId ?? fallbacks.find((c) => c?.provider)?.provider;
  const model = submissionSelection?.modelId ?? fallbacks.find((c) => c?.model)?.model;
  if (!provider || !model) return null;
  const reasoningLevel =
    submissionSelection?.options?.reasoningLevel ??
    fallbacks
      .map((c) => c?.thought || c?.modelSelection?.options?.reasoningLevel)
      .find((value) => !!value);
  return { provider, model, ...(reasoningLevel ? { reasoningLevel } : {}) };
}

export type HighspeedSendContext = {
  override: ReturnType<typeof buildHighspeedRuntimeOverride>;
  acceleratedCard?: HighspeedCardSnapshot;
};

/**
 * Mock 抽中仍保留 accelerated 元数据，但没有 Highspeed 执行材料，
 * 因此只写消息 metadata，让推理继续走当前 session 的普通 provider/model。
 *
 * 加速本轮通过标准 modelSelection + modelExecution{selectionScope:"execution"} 表达：
 * 端点等静态事实来自 Built-in Provider Config，凭据只属于这一次执行、不写 session 常驻选择。
 * 见 docs/highspeed/highspeed-access-mode-migration.md。
 */
export function buildHighspeedRuntimeOverride(
  result: HighspeedPrepareTurnResult | null | undefined,
): {
  highspeedMeta?: HighspeedMessageMeta;
  modelSelection?: ModelSelection;
  modelExecution?: HighspeedModelExecution;
} {
  if (result?.kind !== "accelerated") return {};
  const highspeedMeta: HighspeedMessageMeta = {
    schemaVersion: 1,
    ...result.card,
  };
  if (!result.execution) return { highspeedMeta };
  return {
    highspeedMeta,
    modelSelection: result.execution.modelSelection,
    modelExecution: {
      selectionScope: "execution",
      requestAuth: result.execution.requestAuth,
      selectionFallback: result.execution.selectionFallback,
    },
  };
}

/**
 * 统一发送前的 Highspeed 结果拼装，避免各发送路径分别维护 payload 和 Renderer 统计卡。
 * CLI 仍是最终 admission 权威；这里仅把同一次 prepare 的结果拆成两类既有消费数据。
 */
export async function prepareHighspeedSendContext(
  taskId: string,
  prepareTurn: HighspeedTurnPreparer,
  submissionSelection?: ModelSelection,
): Promise<HighspeedSendContext> {
  const result = await prepareTurn(taskId, submissionSelection);
  return {
    override: buildHighspeedRuntimeOverride(result),
    ...(result?.kind === "accelerated" ? { acceleratedCard: result.card } : {}),
  };
}

/** 发送等待预算：抽卡最多等这么久就放行普通发送（spec §1、§3）。 */
export const HIGHSPEED_SEND_WAIT_BUDGET_MS = 1000;
/**
 * 普通 Decode TPS 读取在发送路径上的等待上限。足以覆盖 Service 缓存命中的一次 RPC 往返
 * （含手机 Web 的 websocket 往返），刻意不足以等完一次真实的 monitor 网络请求。
 */
export const HIGHSPEED_REGULAR_TPS_WAIT_BUDGET_MS = 300;

/**
 * 发送路径上的装饰性读取（regularTps 只决定节省时间展示，不决定鉴权、选型或推理正确性）：
 * 最多等 min(300ms, 1s 发送预算剩余)，超时或失败一律返回 undefined 让 sendText 立即提交。
 * 请求本身不取消——Service 层会合并并发、缓存 5 分钟，超时的那次继续完成即预热缓存，下一轮直接命中。
 *
 * Bug 根因：此前在 prepareTurn 抽中后同步 await 该读取，其 monitor 侧 15s 超时把 1s 发送承诺
 * 拉长到最多 16s（spec §3 规则 12、§9.4）。
 */
export async function readRegularTpsWithinSendBudget(params: {
  read: () => Promise<number | undefined>;
  /** 本次发送从进入 prepare 到现在已消耗的毫秒数，用于扣减剩余预算。 */
  elapsedMs: number;
  onError?: (error: unknown) => void;
  onTimeout?: (budgetMs: number) => void;
  wait?: (milliseconds: number) => Promise<void>;
}): Promise<number | undefined> {
  const budgetMs = Math.max(
    0,
    Math.min(
      HIGHSPEED_REGULAR_TPS_WAIT_BUDGET_MS,
      HIGHSPEED_SEND_WAIT_BUDGET_MS - params.elapsedMs,
    ),
  );
  // 先把 catch 挂好：无论是否等到结果，后台完成时的失败都不能变成 unhandled rejection。
  const reading = (async () => params.read())().then(
    (value) => ({ kind: "value" as const, value }),
    (error: unknown) => {
      params.onError?.(error);
      return { kind: "error" as const };
    },
  );
  if (budgetMs === 0) {
    params.onTimeout?.(0);
    return undefined;
  }
  const wait =
    params.wait ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const outcome = await Promise.race([
    reading,
    wait(budgetMs).then(() => ({ kind: "timeout" as const })),
  ]);
  if (outcome.kind === "timeout") {
    params.onTimeout?.(budgetMs);
    return undefined;
  }
  return outcome.kind === "value" ? outcome.value : undefined;
}
