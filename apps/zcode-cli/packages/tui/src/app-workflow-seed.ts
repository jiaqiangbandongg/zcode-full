// 冷启动 / 恢复会话时的镜像回放、补种与 interrupted notice。
//
// 三条纪律：
//   1. 运行态**只**从回放来：`replayWorkflowRuns` 交出的是 journal 按 sequence 顺序铸出的、与 live
//      同一种进度信封，逐条喂给共享 reducer——有序的真实事件重放不会让相位回退（禁令针对的是
//      「用摘要合成乱序事件」，那条禁令仍然成立：摘要只补展示名）。
//   2. 补种只搬展示名：label / updatedAt；不造 status、不猜 resumable（那是状态位，reducer 搬运）。
//   3. 没有第二时钟：只在挂载与 app 更换时各查一次，不轮询、不 setInterval。
import React from "react";
import type { TuiCopy } from "@zcode/i18n";
import type { WorkflowRunProgressEnvelope } from "@zcode/shared/zcode-protocol-v4";
import type { Message } from "./app-model.js";
import type { TuiListWorkflowRuns, TuiReplayWorkflowRuns, TuiWorkflowRunSummary } from "./types.js";
import type { TuiWorkflowRunSeed } from "./app-workflow-mirror.js";

/** 摘要 → 补种条目。只搬服务端给的展示事实，缺省一律保持缺省（不造 label）。 */
export function workflowRunSeedFromSummary(summary: TuiWorkflowRunSummary): TuiWorkflowRunSeed {
  return {
    runId: summary.runId,
    ...(summary.label === undefined ? {} : { label: summary.label }),
    ...(summary.updatedAt === undefined ? {} : { updatedAt: summary.updatedAt }),
  };
}

/** 一条 notice 文本。label 缺省时退回 runId——列表少一个标签是退化，不是错误。 */
export function workflowInterruptedNoticeText(seed: TuiWorkflowRunSeed, copy: TuiCopy): string {
  return copy.transcript.workflow.interruptedNotice({
    label: seed.label ?? seed.runId,
    runId: seed.runId,
  });
}

/**
 * 把 resumable run 的提示行追加进转写。无 run 时零输出（spec 的 Excludes）。
 *
 * 用 system 行而不是伪造 user 行：这不是用户说的话。
 */
export function appendWorkflowInterruptedNotices(
  messages: Message[],
  seeds: readonly TuiWorkflowRunSeed[],
  copy: TuiCopy,
): Message[] {
  if (seeds.length === 0) return messages;
  return [
    ...messages,
    ...seeds.map((seed) => ({
      content: workflowInterruptedNoticeText(seed, copy),
      role: "system" as const,
    })),
  ];
}

/**
 * 启动 / `/resume` 后要提示的 run：服务端说 `resumable` 的那些。
 *
 * **刻意不排序**：`updatedAt` 是纯展示字段，端口注释明确禁止读侧拿它重排——排序是存储层的职责
 * （最近更新在前），读侧再排一次就会与服务端的 tie-break 漂移。
 */
export function interruptedWorkflowNotices(
  summaries: readonly TuiWorkflowRunSummary[],
): readonly TuiWorkflowRunSeed[] {
  return summaries.filter((summary) => summary.resumable === true).map(workflowRunSeedFromSummary);
}

/**
 * 挂载时先回放、再补种一次。
 *
 * 顺序有讲究：回放先落，卡片一出现就是真实步数；补种随后只给名字。两次查询都失败也不该让
 * TUI 起不来——实时事件仍会把在飞 run 画出来。
 *
 * 回调经 ref 间接调用、依赖里只放两个查询函数的身份：入参对象每次渲染都是新的，直接依赖
 * 会让本 effect 每渲染重跑一次查询（那就是第二个时钟）。
 */
export function useWorkflowRunSeeding(input: {
  copy: TuiCopy;
  listWorkflowRuns?: TuiListWorkflowRuns;
  replayWorkflowRuns?: TuiReplayWorkflowRuns;
  /** 镜像里已有的 run（本进程已收到过事件的）——回放把它们排除在外。 */
  knownRunIds: () => ReadonlySet<string>;
  replay: (envelopes: readonly WorkflowRunProgressEnvelope[]) => void;
  seed: (seeds: readonly TuiWorkflowRunSeed[]) => void;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
}): void {
  const latest = React.useRef(input);
  latest.current = input;
  const { listWorkflowRuns, replayWorkflowRuns } = input;

  React.useEffect(() => {
    if (!listWorkflowRuns && !replayWorkflowRuns) return;
    let cancelled = false;
    void (async () => {
      if (replayWorkflowRuns) {
        try {
          const envelopes = await replayWorkflowRuns({
            excludeRunIds: latest.current.knownRunIds(),
          });
          if (cancelled) return;
          if (envelopes.length > 0) latest.current.replay(envelopes);
        } catch {
          // 回放失败不该让 TUI 起不来。
        }
      }
      if (!listWorkflowRuns) return;
      let summaries: readonly TuiWorkflowRunSummary[];
      try {
        summaries = await listWorkflowRuns();
      } catch {
        return;
      }
      if (cancelled || summaries.length === 0) return;
      latest.current.seed(summaries.map(workflowRunSeedFromSummary));
      // 顺序即服务端顺序（最近更新在前）——端口注释禁止读侧重排。
      const resumable = interruptedWorkflowNotices(summaries);
      if (resumable.length === 0) return;
      latest.current.setMessages((current) =>
        appendWorkflowInterruptedNotices(current, resumable, latest.current.copy),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [listWorkflowRuns, replayWorkflowRuns]);
}
