// 「这次 run 对应哪个已保存工作流」的读缓存（docs/dynamic-workflow/transcript-and-notifications.md
// 「Which workflow a run is saved as」）。
//
// 判定住在 agent（`workflows/forRun`）：两份事实——run 的 journal 记录与磁盘上的定义——都在那边，
// 而卡片上什么都不记。这里只是个缓存：完成卡挂在虚拟列表里，滚动一次就重挂一次，不能每次重挂都
// 发一次 RPC。与中枢的读缓存同一条纪律（savedWorkflowStore）：磁盘仍是唯一权威，变更后一律作废。
import { create } from "zustand";
import type {
  ZCodeSavedWorkflowEntry,
  ZCodeWorkflowsForRunCandidate,
  ZCodeWorkflowsForRunResult,
} from "@zcode/shared";
import { logger } from "@/logger.js";

/**
 * `unsupported` 是**能力**而不是错误：老 agent 根本没有这个方法（JSON-RPC -32601），
 * 卡片据此只留「让 ZCode 帮我提炼保存」那条路。其余失败都按 `error` 处理——查不出来不等于没保存，
 * 所以卡片此时既不画芯片也不画「再次运行」，但「保存」照常可点。
 */
export type WorkflowRunSavedStatus = "loading" | "ready" | "unsupported" | "error";

export interface WorkflowRunSavedState {
  status: WorkflowRunSavedStatus;
  /** 命中的定义；缺席即这次 run 还没有对应的已保存工作流。 */
  entry?: ZCodeSavedWorkflowEntry;
  match?: ZCodeWorkflowsForRunResult["match"];
  /** 这次 run 跑时用的实参，供「再次运行」预填实参窗。 */
  runArgs?: Record<string, unknown>;
}

/** JSON-RPC「方法不存在」：老 agent 的能力探测就靠它（中枢用 -32602 区分旧 scope，同一条先例）。 */
const METHOD_NOT_FOUND = -32601;

interface WorkflowRunSavedStoreState {
  /** 作废代（invalidate 递增）：hook 把它放进依赖，一次作废让所有在场的卡片重查。 */
  generation: number;
  byKey: Record<string, WorkflowRunSavedState>;
  load: (key: string, loader: () => Promise<ZCodeWorkflowsForRunResult>) => Promise<void>;
  /**
   * 自己刚写成的那一份：这一张卡立刻翻面（保留已查到的实参），其余一律作废重查——同名覆盖
   * 可能同时改变别的 run 的答案（按名字命中的那条规则）。
   */
  applySaved: (key: string, entry: ZCodeSavedWorkflowEntry) => void;
  /** 保存 / 删除 / 中枢刷新之后作废：下一次渲染重查。 */
  invalidate: () => void;
  reset: () => void;
}

const inFlight = new Map<string, Promise<void>>();

function extractErrorCode(error: unknown): number | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "number" ? code : null;
}

export const useWorkflowRunSavedStore = create<WorkflowRunSavedStoreState>((set, get) => ({
  generation: 0,
  byKey: {},
  async load(key, loader) {
    const current = inFlight.get(key);
    if (current) return current;
    // 已有结论就不再问：行窗口每次投影更新都会重建候选表（新数组、同内容），卡片的 effect 因此
    // 频繁重跑——不在这里挡住，流式输出的每一拍都会给屏幕上每一张完成卡各发一次 RPC。
    // 结论只由 invalidate 作废（保存、删除、中枢刷新）；候选真变了是另一个键。
    if (get().byKey[key] !== undefined) return;
    set((state) => ({
      byKey: { ...state.byKey, [key]: { ...state.byKey[key], status: "loading" } },
    }));
    // 发出那一刻的代：作废发生在飞行途中时，回来的答案是作废**之前**的事实，丢掉它，
    // 让下一次渲染按新代重查（否则中枢刚删掉的那份会被一个迟到的回答写回卡上）。
    const issuedAt = get().generation;
    const request = loader()
      .then((result) => {
        if (get().generation !== issuedAt) return;
        set((state) => ({
          byKey: {
            ...state.byKey,
            [key]: {
              status: "ready",
              ...(result.entry === undefined ? {} : { entry: result.entry }),
              ...(result.match === undefined ? {} : { match: result.match }),
              ...(result.runArgs === undefined ? {} : { runArgs: result.runArgs }),
            },
          },
        }));
      })
      .catch((error: unknown) => {
        if (get().generation !== issuedAt) return;
        const unsupported = extractErrorCode(error) === METHOD_NOT_FOUND;
        if (!unsupported) {
          logger.warn("[workflowRunSavedStore] 查询这次 run 的已保存工作流失败", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        set((state) => ({
          byKey: { ...state.byKey, [key]: { status: unsupported ? "unsupported" : "error" } },
        }));
      })
      .finally(() => {
        if (inFlight.get(key) === request) inFlight.delete(key);
      });
    inFlight.set(key, request);
    return request;
  },
  applySaved(key, entry) {
    inFlight.clear();
    // 先作废、后落这一份会丢掉它（invalidate 清整张表），卡片在重查回来之前闪回「保存」；
    // 所以两件事在一次 set 里做完：代数递增让别的卡重查，这一张卡带着答案留下，不再重查。
    set((state) => ({
      generation: state.generation + 1,
      byKey: { [key]: { ...state.byKey[key], status: "ready", entry } },
    }));
  },
  invalidate() {
    inFlight.clear();
    // 整张表清掉而不是只清一个 key：一次保存可能同时影响同名的其他 run（按名字命中的那条规则），
    // 而这张表的量级是「屏幕上的完成卡数」，重查的代价远小于一张说错话的卡。
    set((state) => ({ generation: state.generation + 1, byKey: {} }));
  },
  reset() {
    inFlight.clear();
    useWorkflowRunSavedStore.setState({ generation: 0, byKey: {} });
  },
}));

/** 缓存键：工作区 + run + 候选签名。候选变了（对话里刚存过一次）就是另一个问题，必须重查。 */
export function workflowRunSavedKey(
  workspaceKey: string,
  runId: string,
  candidates: readonly ZCodeWorkflowsForRunCandidate[] | undefined,
): string {
  const signature = (candidates ?? [])
    .map((candidate) => `${candidate.scope ?? ""}:${candidate.name}`)
    .join(",");
  return `${workspaceKey}\u0000${runId}\u0000${signature}`;
}

export function selectWorkflowRunSavedState(
  state: WorkflowRunSavedStoreState,
  key: string | null,
): WorkflowRunSavedState | undefined {
  return key === null ? undefined : state.byKey[key];
}

/** 测试用。 */
export function resetWorkflowRunSavedStoreForTests(): void {
  useWorkflowRunSavedStore.getState().reset();
}
