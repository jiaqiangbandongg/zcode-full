import { createQueryId, type ModelSelection, type TurnInputIntentMetadata } from "@zcode/contracts";

/** CLI 配置命令的会话默认值；Core Session 仍独立负责后台与 Goal 续跑。 */
export class CliDefaultSelection {
  private selection: ModelSelection | undefined;
  private inputSequence = 0;

  constructor(selection?: ModelSelection) {
    this.set(selection);
  }

  get(): ModelSelection | undefined {
    return this.selection && structuredClone(this.selection);
  }

  set(selection: ModelSelection | undefined): void {
    this.selection = selection && structuredClone(selection);
  }

  prepareInput<
    T extends {
      inputId?: string;
      intent?: TurnInputIntentMetadata;
      modelExecution?: unknown;
      offPeakTaskId?: string;
      automationId?: string;
    },
  >(options?: T): T & { intent?: TurnInputIntentMetadata } {
    // 只补普通 CLI 用户输入；临时执行和自动续跑有自己的选择与鉴权。
    if (options?.modelExecution || options?.offPeakTaskId || options?.automationId) {
      return { ...options } as T;
    }
    const selection = options?.intent?.modelSelection ?? this.get();
    if (!selection) throw new Error("Select a model before sending a message");
    if (options?.intent) {
      return {
        ...options,
        intent: { ...options.intent, modelSelection: structuredClone(selection) },
      };
    }
    const commandId = options?.inputId ?? String(createQueryId());
    return {
      ...options,
      inputId: commandId,
      intent: {
        sourceCommandId: commandId,
        queueItemId: commandId,
        clientId: "cli",
        kind: "sendText",
        admissionSeq: ++this.inputSequence,
        admittedAt: Date.now(),
        requestedDelivery: "auto",
        admittedDelivery: "startNow",
        modelSelection: structuredClone(selection),
      },
    } as T & { intent: TurnInputIntentMetadata };
  }
}
