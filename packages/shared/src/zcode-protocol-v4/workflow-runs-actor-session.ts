// ============================================================
// actor 的 `sessionId`：持有这个子代理转录的那条会话（workflowRuns 归约的一条规则）
// ============================================================
// 住在归约主文件之外，与 workflow-runs-actor-status.ts 同一个理由（主文件的 max-lines 门），
// 也同一条纪律：纯函数、无时钟、无 I/O。
//
// 为什么 sessionId 会动（docs/dynamic-workflow/presentation.md「Subagent transcripts」）：
// `actor-created` 给的是 run service 为本 run 铸的会话，而修订 run 里一个答案全部来自导入命中的
// 子代理从没建过这条会话——命中不建会话，那些交换只活在前驱的会话里。transcript 面板照
// `sessionId` 订阅，指向一条不存在的会话就只剩 error + retry；所以这个字段要跟着「转录此刻
// 在哪」走，而不是停在铸出来的那个 id 上。

import type { WorkflowRunActor } from "./workflow-runs.js";
import { boundedSessionId } from "./workflow-runs-entries.js";

interface ActorRef {
  siteId: string;
  ordinal: number;
}

/**
 * 一条节点事件之后，它点名的子代理的 actor 表（没变即原引用）。
 *
 * 只有两种 ask 事件说「这个子代理的转录在哪条会话里」：
 *   - **缓存命中的结算**：载荷带 `sourceSessionId` 即答案读自前驱的那条会话（导入命中，或修订
 *     run resume 时对一条导入行的重放）；不带即答案在本 run 里产生过，信封上的 `actorSessionId`
 *     （本 run 的会话）就是它；
 *   - **派发**：子代理开始 live 跑，本 run 的会话此刻已经建好——导入过前缀的已经播了种。
 *
 * 最后一条说了算。同一个子代理的 ask 按序结算，而导入分歧是单调的：导入命中在前、指向前驱的
 * 会话；从第一次 live 派发起，本 run 的会话持有全部，抄进来的前缀也在里面。其余事件、没有
 * actor ref 的事件（world-read）、两个 id 都读不出的老载荷、以及不在表上的子代理：一律不动。
 */
export function actorsWithTranscriptSession(
  actors: WorkflowRunActor[],
  eventType: string,
  payload: Record<string, unknown>,
  actorRef: ActorRef | null,
  envelopeSessionId: string | undefined,
): WorkflowRunActor[] {
  if (actorRef === null) return actors;
  const sessionId =
    eventType === "node-settled" && payload.cached === true
      ? (boundedSessionId(payload.sourceSessionId) ?? boundedSessionId(envelopeSessionId))
      : eventType === "node-dispatched"
        ? boundedSessionId(envelopeSessionId)
        : undefined;
  if (sessionId === undefined) return actors;
  const index = actors.findIndex(
    (actor) => actor.siteId === actorRef.siteId && actor.ordinal === actorRef.ordinal,
  );
  // 没变的保持引用：键级增量按引用先判「这条变了吗」（workflow-runs-delta.ts）。
  if (index < 0 || actors[index]!.sessionId === sessionId) return actors;
  const next = actors.slice();
  next[index] = { ...actors[index]!, sessionId };
  return next;
}
