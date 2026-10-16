// ============================================================
// Dynamic Workflow Run Service：run 内省读面（ListWorkflowRuns / GetWorkflowRun）
// ============================================================
// dynamic-workflow-run-service.ts 顶到 oxlint max-lines 上限（400 行），把 `listRuns` /
// `getRunDetail` 两个可选端口成员及其 pendingQuestions 切片拆到本文件；公开面仍从
// dynamic-workflow-run-service.ts 导出。两个成员只在 journal 带内省查询时装进服务对象——
// 缺席时整个不实现的判定仍在 service（见那边的 `introspection` 字段注释）。

import type {
  DynamicWorkflowRunDetail,
  DynamicWorkflowRunHole,
  DynamicWorkflowRunLifecycleStatus,
  DynamicWorkflowRunListItem,
  DynamicWorkflowRunListQuery,
  DynamicWorkflowRunListResult,
  DynamicWorkflowRunPendingQuestion,
  DynamicWorkflowRunPort,
} from "@zcode/contracts";
import { NON_REPORT_NODE_KINDS, type JournalStorePort } from "@zcode/dynamic-workflow";
import { reduceWorkflowRunsState, type WorkflowRunsState } from "@zcode/shared/zcode-protocol-v4";
import type { DynamicWorkflowIntrospectableJournal } from "./dynamic-workflow-run-journal.js";
import {
  readRunModelBindings,
  readRunScriptPath,
  readRunSubagentModel,
} from "./dynamic-workflow-run-launch-anchor.js";
import {
  artifactsOf,
  journalRunSummary,
  registryRunSummary,
  runConcurrencyField,
  runScriptPathField,
  runModelBindingsField,
  runSubagentModelField,
  terminalErrorField,
  terminalResultField,
  toLogTailEntry,
  TERMINAL_RUN_STATUSES,
  type RunRegistryEntry,
} from "./dynamic-workflow-run-observation.js";
import {
  COLD_REPLAY_EVENT_READ,
  replayRunProgressFromEvents,
} from "./dynamic-workflow-run-replay.js";
import { runHolesOf } from "./dynamic-workflow-run-holes.js";
import { buildWorkflowRunRoster } from "./dynamic-workflow-run-roster.js";
import type { WorkflowEscalationRegistry } from "./workflow-escalation-registry.js";

/**
 * `getRunDetail` 默认取的 `log()` 尾巴条数。尾巴是叙事进展的取样而不是完整日志——完整事件
 * 日志有 {@link DynamicWorkflowRunPort.listEvents} 的分页面。
 */
const DEFAULT_LOG_TAIL_LIMIT = 20;

/** 内省读面要读的 service 内部状态：注册表与停驻表都是**同一实例**的引用，不是副本。 */
interface DynamicWorkflowRunIntrospectionContext {
  /** 已按能力探测窄化的 journal（与 `journal` 是同一个对象，只是类型更宽）。 */
  introspection: DynamicWorkflowIntrospectableJournal;
  journal: JournalStorePort;
  parentSessionId: string;
  /** service 的内存注册表（在飞 + 有界终态）。 */
  runs: ReadonlyMap<string, RunRegistryEntry>;
  /** 升级问答的停驻表，pendingQuestions 切片的唯一投影源。 */
  escalations: WorkflowEscalationRegistry;
  /**
   * 本进程的默认并发（service 的那一份实现）。详情面据它判断一个 run 的上界值不值得一提
   * （{@link runConcurrencyField}）。是函数而不是数：内省成员在服务构造时造好一次，而默认值
   * 是每次读时的事实。
   */
  defaultConcurrency: () => number;
}

/** 造 `listRuns` / `getRunDetail` 两个成员，由 service 展开进返回的端口对象。 */
export function createRunIntrospectionMethods(
  ctx: DynamicWorkflowRunIntrospectionContext,
): Required<Pick<DynamicWorkflowRunPort, "listRuns" | "getRunDetail">> {
  const { introspection, journal, parentSessionId, runs, escalations, defaultConcurrency } = ctx;
  return {
    /**
     * 按项目枚举 run：journal 行 ∪ 本会话注册表。**只读**——`possiblyInterrupted` 是
     * 读面的标注，绝不改写 journal（替兄弟会话在飞的 run 收尸 = 把活着的 run 标死；
     * 孤儿收敛的执行权只属于 owning 会话的构造时刻，见文件头不变式 4）。
     */
    async listRuns(query: DynamicWorkflowRunListQuery): Promise<DynamicWorkflowRunListResult> {
      const limit = Math.max(0, query.limit);
      // 多取一条**只为判定 truncated**，它不进结果页。判据绝不能是 `length === limit`：
      // 条数正好等于 limit 时那会误报，而误报会让模型去追一页不存在的历史。同一个惯例在
      // v4 网关的事件分页（hasMore）上已经用过一次。
      const rows = introspection.listRuns({
        cwd: query.cwd,
        limit: limit + 1,
        ...(query.statuses === undefined ? {} : { statuses: query.statuses }),
      });
      const journalItems = rows.map((row) => ({
        ...journalRunSummary(row, runs.get(row.runId), parentSessionId),
        spentTokens: row.spentTokens,
      }));

      // 注册表补集：submit 已返回、引擎还没 createRun 的那几个微任务里，journal 里
      // 没有任何痕迹。少了这一支，模型刚起的 run 会在自己的项目列表里整个消失。
      const listed = new Set(rows.map((row) => row.runId));
      const gapItems: DynamicWorkflowRunListItem[] = [];
      for (const [runId, entry] of runs) {
        if (listed.has(runId) || entry.cwd !== query.cwd) continue;
        // 行已存在却没被这次查询选中，说明它是被 limit / statuses 排除的——补集绝不
        // 把它捞回来（那等于让一个显式传下来的过滤器静默失效）。
        if (journal.getRun(runId) !== undefined) continue;
        const summary = registryRunSummary(runId, entry);
        if (query.statuses !== undefined && !query.statuses.includes(summary.status)) continue;
        // 用量：行还没落，但修订 run 的起点在 submit 那一刻就已确定（见 RunRegistryEntry.inheritedTokens）。
        // 全新 run 没有起点 ⇒ 0，与之前一致。
        gapItems.push({ ...summary, spentTokens: entry.inheritedTokens ?? 0 });
      }

      // 间隙里的 run 一定是最新提交的（journal 行落下之前只有几个微任务），所以按
      // 提交时间倒序排在 time_updated desc 的 journal 行之前；limit 是整页的界。
      gapItems.sort((left, right) => right.createdAt - left.createdAt);
      const merged = [...gapItems, ...journalItems];
      const truncated = merged.length > limit;
      return {
        runs: truncated ? merged.slice(0, limit) : merged,
        // 为真时才在场：`false` 是每一页都要带的噪音字段。
        ...(truncated ? { truncated: true } : {}),
      };
    },

    /** 单 run 详情：dwf_run 行 + 节点计数 + actors + log 尾巴 + 内存终态产物。 */
    async getRunDetail(runId: string): Promise<DynamicWorkflowRunDetail | undefined> {
      const row = introspection.getRunRow(runId);
      const entry = runs.get(runId);
      if (row === undefined) {
        // 两者都没有 → 真的未知（工具层归一成 run_not_found）。只有注册表有 → 正是
        // 上面那个间隙：run 确实存在，报 not_found 会是一句谎。
        if (entry === undefined) return undefined;
        const gapSummary = registryRunSummary(runId, entry);
        // 情势截面的间隙形态：一条事件、一个节点行都还没有，所以阶段表缺席、花名册为空、
        // 健康全零。唯一有内容的是 `pendingQuestionsKnown` —— 条目就在本会话手里，
        // 停驻表当然查得到（而这一刻恰恰**最可能**停着问题，见下面的 pendingQuestions 注释）。
        const gapRoster = buildWorkflowRunRoster({
          run: undefined,
          events: [],
          nodes: [],
          actors: [],
          status: gapSummary.status,
          pendingQuestions: escalations.pendingFor(runId),
          now: Date.now(),
        });
        return {
          ...gapSummary,
          // 并发上界的间隙副本（见 RunRegistryEntry.maxConcurrency）：行还没落，但这个值在
          // submit 那一刻就已确定，详情面没有理由在这几个微任务里装作不知道。
          ...runConcurrencyField(entry.maxConcurrency, defaultConcurrency()),
          // 子代理模型的间隙副本，同一条论证（见 RunRegistryEntry.subagentModel）。
          ...runSubagentModelField(entry.subagentModel),
          // 脚本点名的模型的间隙副本，同一条论证。
          ...runModelBindingsField(entry.modelBindings),
          // 脚本文件的间隙副本，同一条论证（见 RunRegistryEntry.scriptPath）。
          ...runScriptPathField(entry.scriptPath),
          // 计数此刻还没有任何权威来源，诚实地为 0；用量的起点却是已知的（修订 run 继承前驱的
          // 累计值，见 RunRegistryEntry.inheritedTokens），报 0 会说「这条 lineage 没花钱」。
          usage: {
            spentTokens: entry.inheritedTokens ?? 0,
            nodesObserved: 0,
            nodesRunning: 0,
            nodesCompleted: 0,
            nodesFailed: 0,
          },
          actors: [],
          logTail: [],
          ...gapRoster,
          ...terminalResultField(gapSummary.status, entry),
          ...terminalErrorField(gapSummary.status, entry),
          // 这条间隙分支正是「run 在飞、journal 行还没落」的那一刻，也就是问题**最可能**
          // 停驻的时刻——漏掉它，刚起步的 run 里那个被挡住的 actor 在模型侧不可见。
          ...pendingQuestionsField(escalations, runId),
          // 留白与停驻问题同一条论证：间隙里条目在手，引擎的停驻表查得到；零条整字段缺席。
          ...holesField(runHolesOf(runId, entry, journal)),
          // 产物：这条间隙分支里 dwf_run 行还没落，
          // 但**节点行可能已经落了**——引擎在 createRun 之后立刻就能 putNode 一条 artifact
          // 行。所以这里照样取一次，而不是想当然地给空：一个刚声明完看板就被查详情的 run
          // 不该在模型侧显得什么都没产出。零件时 artifactsOf 让整个字段缺席。
          ...artifactsOf(runId, journal),
        };
      }

      const summary = journalRunSummary(row, entry, parentSessionId);
      const counts = introspection.countNodesByStatus(runId);
      // 事件**只读一遍**：同一份序列
      // 先经冷回放那条铸造链归约成 run 面板同款状态，再连同节点行 / actor 行喂给情势截面。
      // 两边各读一次就是为同一份数据付两遍钱，而这条查询在长 run 上正是最贵的一段。
      // report item 只读到投影的界为止（与冷回放同一条读，见 dynamic-workflow-run-replay.ts）。
      const stored = journal.listEvents(runId, COLD_REPLAY_EVENT_READ);
      // actor 行只读一次、不带 persona（整段 system prompt 是天然无界的字段，这里没有读者）。
      const actorRows = journal.listActors(runId, { withPersona: false });
      const pendingQuestions = pendingQuestionsOf(escalations, runId, summary.status, entry);
      return {
        ...summary,
        // 落库的上界（`dwf_run.caps_max_concurrency`），只在不等于默认并发时在场。刻意不进
        // journalRunSummary——那是列表行的共同截面，一个很少设置的字段不该把每一行都加宽。
        ...runConcurrencyField(row.caps.maxConcurrency, defaultConcurrency()),
        // 本 run 的子代理模型，只在设过时在场。它不在 dwf_run 的列上（用户裁决不做迁移）——
        // 权威是 `run-launched` 事件。与快照同一条规则：有条目就读条目（三条建条目的路都落值），
        // 只有冷行才去扫一次事件头。与并发上界同规地刻意不进 journalRunSummary：一个很少设置
        // 的字段不该把列表的每一行都加宽。
        ...runSubagentModelField(
          entry === undefined ? readRunSubagentModel(journal, runId) : entry.subagentModel,
        ),
        // 本 run 的脚本文件，只在记过时在场。与子代理模型逐条同规：权威是 `run-launched`
        // 事件（dwf_run 上没有这一列），有条目就读条目，只有冷行才去扫一次事件头；同样刻意
        // 不进 journalRunSummary——列表行不该为一个只有 AmendWorkflow 用得上的字段加宽。
        ...runModelBindingsField(
          entry === undefined ? readRunModelBindings(journal, runId) : entry.modelBindings,
        ),
        ...runScriptPathField(
          entry === undefined ? readRunScriptPath(journal, runId) : entry.scriptPath,
        ),
        usage: {
          // 直读 dwf_run.spent_tokens：run 级 token 用量的唯一权威。
          spentTokens: row.spentTokens,
          // 已落库节点的行数之和，**不是**「总步数」：动态工作流没有静态总数，
          // 而 queued 只存在于事件相位、不落库。
          nodesObserved: counts.running + counts.completed + counts.failed,
          nodesRunning: counts.running,
          nodesCompleted: counts.completed,
          nodesFailed: counts.failed,
        },
        actors: actorRows.map((actor) => ({
          siteId: actor.siteId,
          ordinal: actor.ordinal,
          // persona 刻意不出：整段 system prompt 是端口上天然无界的那类字段。
          ...(actor.name === undefined ? {} : { name: actor.name }),
        })),
        logTail: introspection
          .listRecentLogEvents(runId, DEFAULT_LOG_TAIL_LIMIT)
          .map(toLogTailEntry),
        ...buildWorkflowRunRoster({
          run: reduceRunState(row, stored, defaultConcurrency()),
          events: stored,
          // 花名册只读 kind / status / stats / 坐标：不带结果、不读 report 行。
          nodes: journal.listNodes(runId, { kinds: NON_REPORT_NODE_KINDS, withResult: false }),
          actors: actorRows,
          status: summary.status,
          ...(pendingQuestions === undefined ? {} : { pendingQuestions }),
          now: Date.now(),
        }),
        ...terminalResultField(summary.status, entry, row),
        ...terminalErrorField(summary.status, entry, row),
        ...(pendingQuestions === undefined || pendingQuestions.length === 0
          ? {}
          : { pendingQuestions }),
        // 留白（docs/execution-engine.md「The run snapshot」）：与快照同源同投影——这是留白通知
        // 丢失后模型侧唯一的发现面。冷行的事实表从行里的脚本重建（只在真有留白到达时）。
        ...holesField(runHolesOf(runId, entry, journal, row.scriptText)),
        // 产物截面：任意状态都附，含 failed / cancelled
        // ——一个死在第 12 步的 run 仍然交付了它前面产出的那张图。与 `listArtifacts` 和终态
        // 快照走**同一个** artifactsOf，三处给出同一份清单（三处各归并一份，迟早会在
        // 「失败行算不算一版」这种地方分叉）。零件时整个字段缺席。
        ...artifactsOf(runId, journal),
      };
    },
  };
}

/**
 * `getRunDetail` 的 pendingQuestions 切片。
 *
 * 与 `getTask` 快照**同一个投影源**（内存的升级停驻表），刻意不走 journal 重放：journal 里有
 * raised / resolved 两类事件，但「现在还欠谁一个答案」是进程内的活事实——重放出来的未配对
 * raised 在进程亡故后只会说谎（停驻的 deferred 早已随进程消失）。
 *
 * 零条时整字段缺席（不发空数组，与快照同规）：空数组读起来像「问过、已答完」，缺席读起来
 * 才是「没人在等」。
 */
function pendingQuestionsField(
  escalations: WorkflowEscalationRegistry,
  runId: string,
): Pick<DynamicWorkflowRunDetail, "pendingQuestions"> {
  const pendingQuestions = escalations.pendingFor(runId);
  return pendingQuestions.length === 0 ? {} : { pendingQuestions };
}

/** 零条整字段缺席（与 pendingQuestions 同规）。 */
function holesField(
  holes: readonly DynamicWorkflowRunHole[],
): Pick<DynamicWorkflowRunDetail, "holes"> {
  return holes.length === 0 ? {} : { holes };
}

/**
 * 这次读**能不能**回答「有没有问题在等答案」，以及答案本身
 * （`health.pendingQuestionsKnown`）。
 *
 * `undefined` = 查不到，不是「没有」。停驻表是**本进程内存**里的表（见 {@link pendingQuestionsField}
 * 的论证），所以只有两种情况下这次读说得出实话：run 就在本会话的注册表里，或者 run 已终态
 * ——终态 run 按定义没有还在听的人。其余情况（兄弟会话在飞的 run、死进程的遗物）
 * 空表与「不知道」长得一模一样，而这两者对模型是两个不同的下一步：一个可以继续等，
 * 另一个得换条路去问。
 */
function pendingQuestionsOf(
  escalations: WorkflowEscalationRegistry,
  runId: string,
  status: DynamicWorkflowRunLifecycleStatus,
  entry: RunRegistryEntry | undefined,
): readonly DynamicWorkflowRunPendingQuestion[] | undefined {
  const known = entry !== undefined || TERMINAL_RUN_STATUSES.has(status);
  return known ? escalations.pendingFor(runId) : undefined;
}

/**
 * journal 事件 → run 面板同款归约状态。`node-queued` 的任务摘要与 `node-progress` 的进度读数
 * 只活在事件上，而把它们摘出来的规则已经在 reducer 里写过一遍——这里复用那一遍，而不是在读面
 * 再写一个解析器（两个解析器迟早会在「重新排队要不要清掉轮次」这种地方分叉）。
 *
 * 事件由调用方读好递进来；`replayRunProgressFromEvents` 是冷回放那条铸造链本身，所以这里
 * 归约出的状态与重启后 UI 看到的逐字节相同。
 */
function reduceRunState(
  row: Parameters<typeof replayRunProgressFromEvents>[0],
  stored: Parameters<typeof replayRunProgressFromEvents>[1],
  defaultConcurrency: number,
): WorkflowRunsState["runs"][number] | undefined {
  let state: WorkflowRunsState | undefined;
  for (const payload of replayRunProgressFromEvents(row, stored, defaultConcurrency)) {
    state = reduceWorkflowRunsState(state, payload) ?? state;
  }
  return state?.runs.find((run) => run.runId === row.runId);
}
