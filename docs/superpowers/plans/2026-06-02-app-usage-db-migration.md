# 应用用量数据源迁移到 agent 数据库 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「应用用量」面板的数据源从「本地 session JSON 文件 + 字符估算」整条替换为 zcode agent SQLite 库（`model_usage` / `turn_usage` / `tool_usage`）的真实统计，并新增真实 token 拆分、可靠性指标、工具使用区块。

**Architecture:** agent 子进程内用 SQL 聚合（adapters repo）→ 纯函数 builder 组装快照（bootstrap）→ 新增 ZCode Protocol 方法 `usage/stats`（shared schema + bootstrap handler）→ 宿主 `usageStatsService` 经 `zcodeAgentService` 走协议取数（packages/services）→ UI 重绘 4 个区块（packages/ui）。聚合放在 agent 侧，天然受 30 天保留期约束。

**Tech Stack:** TypeScript, Node.js `node:sqlite` (`DatabaseSync`), zod, React, vitest, lucide-react, recharts。

**Spec:** `docs/superpowers/specs/2026-06-02-app-usage-db-migration-design.md`

---

## 关键约定（贯穿全计划，命名必须一致）

- 新时间范围类型：`AppUsageRange = "7d" | "30d"`（App Usage 专用，**不复用** `UsageStatsRange`，后者仍服务 Coding Plan/monitor 路径）。
- 新协议方法常量名：`usageStats`，方法字符串 `"usage/stats"`。
- agent 侧只读聚合端口方法：`UsageStorePort.queryAppUsage(input: AppUsageQueryInput): Promise<AppUsageQueryResult>`。
- 纯函数 builder：`buildAppUsageSnapshot(result, opts): AppUsageSnapshot`，位于 `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/usage-stats-builder.ts`。
- 时区按「固定偏移」归日：`tzOffsetMs`（由 handler 用 Intl 计算并下传），`dayIndex = floor((started_at + tzOffsetMs) / 86400000)`。DST 边界有微小误差，可接受（注释里写明）。

## 文件结构图（创建 / 修改）

**Phase 0 — DTO**
- Modify `packages/shared/src/usage-stats.ts` — 删字符估算类型，新增 App Usage zod schema + 类型 + `AppUsageRange`。

**Phase 1 — agent 读层**
- Modify `apps/zcode-cli/packages/contracts/src/interfaces/session-store.port.ts` — 新增 `AppUsageQueryInput` / `AppUsageQueryResult` 等 raw 类型 + `queryAppUsage` 端口方法。
- Modify `apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/usage.ts` — 新增 `queryAppUsage(db, input)` 的 SQL 聚合。
- Modify `apps/zcode-cli/packages/adapters/src/storage/session-store/sqlite-session-store.ts` — 代理 `queryAppUsage`。
- Test `apps/zcode-cli/packages/adapters/tests/usage-query.test.ts` — repo 聚合断言。

**Phase 2 — builder + 协议**
- Create `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/usage-stats-builder.ts` — 纯函数 builder + `tzOffsetMs` 助手。
- Test `apps/zcode-cli/packages/bootstrap/tests/usage-stats-builder.test.ts`。
- Modify `packages/shared/src/zcode-protocol/index.ts` — 注册 `usageStats` 方法 + 入参/结果 schema。
- Modify `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts` — `usageStats` handler。
- Modify `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server.ts` — dispatch case。
- Modify `packages/services/src/zcode-agent/zcodeAgentService.ts` (+ 其类型/接口文件) — `getAppUsageStats` 方法。

**Phase 3 — 宿主服务**
- Modify `packages/services/src/usage-stats/usageStatsService.ts` — 重写 `getAppUsageSnapshot` 走协议。
- Modify `packages/desktop/src/host/remoteWorkspaceServiceCollection.ts` — 注入 `zcodeAgentService`。
- Delete `packages/services/src/usage-stats/usageStatsAggregator.ts`、`repo/sessionUsageRepo.ts`、`usageStatsSeries.ts`（若存在）。
- Modify `packages/services/src/usage-stats/usageStats.ts` — `getAppUsageSnapshot` 入参类型改 `AppUsageRequest`（range: AppUsageRange）。

**Phase 4 — UI**
- Modify `packages/ui/src/settings/usage-stats/AppUsagePanel.tsx`、`usageStatsUiParts.tsx`、`AppUsageDailyModelBarChart.tsx`、`packages/ui/src/hooks/useUsageStats.ts`、i18n messages 文件。

---

## Phase 0 — 共享 DTO

### Task 0: 新增 App Usage DTO（zod schema + 类型）

**Files:**
- Modify: `packages/shared/src/usage-stats.ts`

- [ ] **Step 1: 在文件顶部确认 zod 可用并新增 schema 段**

在 `packages/shared/src/usage-stats.ts` **顶部**加导入（若已存在 `import { z } from "zod"` 则跳过）：

```typescript
import { z } from "zod";
```

- [ ] **Step 2: 删除字符估算相关导出**

删除这些（它们属于旧本地估算管线，迁移后无来源）：
- `export const ESTIMATED_TOKEN_CHAR_DIVISOR = 3;`（第 1 行）
- `export function estimateTokensFromCharacterCount(...) { ... }`（文件末尾整段）
- 接口 `UsageStatsDailyModelUsage` / `UsageStatsDailyModelUsageItem`（被新 App Usage 类型取代）
- `AppUsageSnapshot` 旧定义（第 130-134 行）与旧 `AppUsageRequest`（第 24-27 行）

> `UsageStatsSnapshot` / `UsageStatsSummary` / `UsageStatsHeatmap*` / `UsageStatsModelUsage` 等仍被 Coding Plan/monitor 与 `getSnapshot` 使用，**保留不动**。`UsageStatsRange` 保留。

- [ ] **Step 3: 新增 App Usage 的 zod schema 与类型**

在文件中（Coding Plan 段之前）插入：

```typescript
// ── App Usage（agent 数据库真实统计）────────────────────────────────
export const APP_USAGE_RANGES = ["7d", "30d"] as const;
export type AppUsageRange = (typeof APP_USAGE_RANGES)[number];

export const appUsageFavoriteModelSchema = z.object({
  modelId: z.string().nullable(),
  totalTokens: z.number(),
  share: z.number(),
});

export const appUsageSummarySchema = z.object({
  totalTokens: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  reasoningTokens: z.number(),
  cacheCreationTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheHitRate: z.number(),
  totalSessions: z.number(),
  totalTurns: z.number(),
  toolCallCount: z.number(),
  toolErrorRate: z.number(),
  modelErrorRate: z.number(),
  avgTimeToFirstTokenMs: z.number().nullable(),
  avgTurnDurationMs: z.number().nullable(),
  activeDays: z.number(),
  currentStreakDays: z.number(),
  favoriteModel: appUsageFavoriteModelSchema.nullable(),
});

export const appUsageHeatmapCellSchema = z.object({
  date: z.string(),
  level: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  totalTokens: z.number(),
  turnCount: z.number(),
  toolCallCount: z.number(),
});

export const appUsageHeatmapWeekSchema = z.object({
  weekIndex: z.number(),
  days: z.array(appUsageHeatmapCellSchema.nullable()),
});

export const appUsageHeatmapSchema = z.object({
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  maxTokens: z.number(),
  weeks: z.array(appUsageHeatmapWeekSchema),
});

export const appUsageDailyModelItemSchema = z.object({
  modelId: z.string().nullable(),
  totalTokens: z.number(),
});

export const appUsageDailyModelUsageSchema = z.object({
  date: z.string(),
  models: z.array(appUsageDailyModelItemSchema),
});

export const appUsageModelUsageSchema = z.object({
  modelId: z.string().nullable(),
  totalTokens: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  requestCount: z.number(),
  share: z.number(),
});

export const appUsageToolUsageSchema = z.object({
  toolName: z.string(),
  callCount: z.number(),
  errorCount: z.number(),
  errorRate: z.number(),
  avgDurationMs: z.number().nullable(),
});

export const appUsageSnapshotSchema = z.object({
  range: z.enum(APP_USAGE_RANGES),
  generatedAt: z.number(),
  timeZone: z.string(),
  source: z.literal("agent-db"),
  summary: appUsageSummarySchema,
  heatmap: appUsageHeatmapSchema,
  dailyModelUsage: z.array(appUsageDailyModelUsageSchema),
  models: z.array(appUsageModelUsageSchema),
  tools: z.array(appUsageToolUsageSchema),
});

export type AppUsageSummary = z.infer<typeof appUsageSummarySchema>;
export type AppUsageHeatmapCell = z.infer<typeof appUsageHeatmapCellSchema>;
export type AppUsageHeatmapWeek = z.infer<typeof appUsageHeatmapWeekSchema>;
export type AppUsageHeatmap = z.infer<typeof appUsageHeatmapSchema>;
export type AppUsageDailyModelItem = z.infer<typeof appUsageDailyModelItemSchema>;
export type AppUsageDailyModelUsage = z.infer<typeof appUsageDailyModelUsageSchema>;
export type AppUsageModelUsage = z.infer<typeof appUsageModelUsageSchema>;
export type AppUsageToolUsage = z.infer<typeof appUsageToolUsageSchema>;
export type AppUsageFavoriteModel = z.infer<typeof appUsageFavoriteModelSchema>;
export type AppUsageSnapshot = z.infer<typeof appUsageSnapshotSchema>;

export interface AppUsageRequest {
  range: AppUsageRange;
  timeZone?: string;
}
```

- [ ] **Step 4: 确认 shared barrel 导出**

确认 `packages/shared/src/usage-stats.ts` 已被 `packages/shared/src/index.ts` 重导出（搜索 `usage-stats`）。若是 `export * from "./usage-stats.js"` 则无需改。

- [ ] **Step 5: 编译验证**

Run: `cd packages/shared && npx tsc --noEmit`
Expected: PASS（若有引用旧 `estimateTokensFromCharacterCount` / 旧 `AppUsageSnapshot` 的下游报错，属预期，将在后续 Task 修掉；本步只需 shared 包自身类型自洽）。

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/usage-stats.ts
git commit -m "feat(usage): add app usage db-backed DTO schemas"
```

---

## Phase 1 — agent 数据库读层

### Task 1: contracts 增加 raw 查询类型与端口方法

**Files:**
- Modify: `apps/zcode-cli/packages/contracts/src/interfaces/session-store.port.ts`

- [ ] **Step 1: 在 `UsageStorePort` 之前插入 raw 查询类型**

在 `export interface UsageStorePort {`（约第 595 行）**之前**插入：

```typescript
export interface AppUsageQueryInput {
  /** 含 (since, until] 的下界（unix ms）。 */
  since: number;
  /** 上界（unix ms），通常为 now。 */
  until: number;
  /** 调用端时区相对 UTC 的固定偏移（ms），用于按本地日归桶。 */
  tzOffsetMs: number;
}

export interface AppUsageTotalsRow {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  modelRequestCount: number;
  modelErrorCount: number;
  avgTimeToFirstTokenMs: number | null;
}

export interface AppUsageTurnTotalsRow {
  totalSessions: number;
  totalTurns: number;
  avgTurnDurationMs: number | null;
}

export interface AppUsageToolTotalsRow {
  toolCallCount: number;
  toolErrorCount: number;
}

export interface AppUsageModelRow {
  modelId: string | null;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  requestCount: number;
}

export interface AppUsageToolRow {
  toolName: string;
  callCount: number;
  errorCount: number;
  avgDurationMs: number | null;
}

export interface AppUsageDayRow {
  dayIndex: number;
  totalTokens: number;
  turnCount: number;
  toolCallCount: number;
}

export interface AppUsageDayModelRow {
  dayIndex: number;
  modelId: string | null;
  totalTokens: number;
}

export interface AppUsageQueryResult {
  totals: AppUsageTotalsRow;
  turnTotals: AppUsageTurnTotalsRow;
  toolTotals: AppUsageToolTotalsRow;
  models: AppUsageModelRow[];
  tools: AppUsageToolRow[];
  days: AppUsageDayRow[];
  dayModels: AppUsageDayModelRow[];
}
```

- [ ] **Step 2: 在端口接口中加只读方法**

修改 `UsageStorePort`（第 595-600 行），加一行：

```typescript
export interface UsageStorePort {
  recordModelUsage(input: ModelUsageRecord): Promise<void>;
  upsertTurnUsage(input: TurnUsageRecord): Promise<void>;
  upsertToolUsage(input: ToolUsageRecord): Promise<void>;
  pruneUsage(input?: { beforeTime?: number }): Promise<void>;
  queryAppUsage(input: AppUsageQueryInput): Promise<AppUsageQueryResult>;
}
```

- [ ] **Step 3: 编译验证**

Run: `cd apps/zcode-cli/packages/contracts && npx tsc --noEmit`
Expected: PASS（实现类 `SqliteSessionStore` 未实现新方法的报错会在它的包里出现，不在 contracts 包内，本步 PASS）。

- [ ] **Step 4: Commit**

```bash
git add apps/zcode-cli/packages/contracts/src/interfaces/session-store.port.ts
git commit -m "feat(contracts): add app usage read port + raw query types"
```

---

### Task 2: adapters 实现 SQL 聚合 + 代理（先写测试）

**Files:**
- Test: `apps/zcode-cli/packages/adapters/tests/usage-query.test.ts`
- Modify: `apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/usage.ts`
- Modify: `apps/zcode-cli/packages/adapters/src/storage/session-store/sqlite-session-store.ts`

- [ ] **Step 1: 写失败测试**

创建 `apps/zcode-cli/packages/adapters/tests/usage-query.test.ts`：

```typescript
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createProjectId,
  createSessionId,
  createToolCallId,
  createTraceId,
  createTurnId,
} from "@zcode/contracts";
import { createSqliteSessionStore } from "../src/storage/index.js";

const DAY = 24 * 60 * 60 * 1000;

describe("queryAppUsage", () => {
  it("aggregates tokens, tools, and per-day buckets within range", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-usage-query-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const store = createSqliteSessionStore({ dbPath });
    const sessionID = createSessionId("uq");
    const turnID = createTurnId("uq-turn");
    const now = 1_900_000_000_000; // 固定基准，避免依赖 Date.now()
    try {
      await store.createSession({
        id: sessionID,
        projectID: createProjectId("uq"),
        slug: "uq",
        directory: tempRoot,
        title: "uq",
        version: "0.1.0",
      });
      await store.recordModelUsage({
        id: "m1",
        logicalRequestId: "r1",
        sessionID,
        turnID,
        traceID: createTraceId(),
        querySource: "main_turn",
        providerID: "p",
        modelID: "model-a",
        status: "completed",
        startedAt: now - 1 * DAY,
        timeToFirstTokenMs: 100,
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 80,
        cacheCreationInputTokens: 5,
        computedTotalTokens: 100,
      });
      await store.recordModelUsage({
        id: "m2",
        logicalRequestId: "r2",
        sessionID,
        turnID,
        querySource: "main_turn",
        providerID: "p",
        modelID: "model-a",
        status: "error",
        startedAt: now - 2 * DAY,
        inputTokens: 4,
        outputTokens: 0,
        computedTotalTokens: 4,
      });
      await store.upsertTurnUsage({
        sessionID,
        turnID,
        status: "completed",
        startedAt: now - 1 * DAY,
        durationMs: 2000,
        computedTotalTokens: 100,
      });
      await store.upsertToolUsage({
        id: "t1",
        sessionID,
        turnID,
        toolCallID: createToolCallId("c1"),
        toolName: "Read",
        status: "completed",
        startedAt: now - 1 * DAY,
        durationMs: 50,
      });
      await store.upsertToolUsage({
        id: "t2",
        sessionID,
        turnID,
        toolCallID: createToolCallId("c2"),
        toolName: "Read",
        status: "error",
        startedAt: now - 1 * DAY,
        durationMs: 150,
      });

      const result = await store.queryAppUsage({
        since: now - 30 * DAY,
        until: now,
        tzOffsetMs: 0,
      });

      expect(result.totals.totalTokens).toBe(104);
      expect(result.totals.inputTokens).toBe(14);
      expect(result.totals.cacheReadTokens).toBe(80);
      expect(result.totals.modelRequestCount).toBe(2);
      expect(result.totals.modelErrorCount).toBe(1);
      expect(result.turnTotals.totalSessions).toBe(1);
      expect(result.turnTotals.totalTurns).toBe(1);
      expect(result.toolTotals.toolCallCount).toBe(2);
      expect(result.toolTotals.toolErrorCount).toBe(1);

      const readTool = result.tools.find((t) => t.toolName === "Read");
      expect(readTool).toMatchObject({ toolName: "Read", callCount: 2, errorCount: 1 });
      expect(readTool?.avgDurationMs).toBe(100);

      const modelA = result.models.find((m) => m.modelId === "model-a");
      expect(modelA).toMatchObject({ modelId: "model-a", totalTokens: 104, requestCount: 2 });

      // 两条 model_usage 落在两个不同的本地日
      expect(result.days.length).toBe(2);
      const dayWithTurn = result.days.find((d) => d.turnCount === 1);
      expect(dayWithTurn?.totalTokens).toBe(100);
      expect(dayWithTurn?.toolCallCount).toBe(2);

      expect(result.dayModels.some((d) => d.modelId === "model-a" && d.totalTokens === 100)).toBe(
        true,
      );
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/zcode-cli && npx vitest run packages/adapters/tests/usage-query.test.ts`
Expected: FAIL（`store.queryAppUsage is not a function`）。

- [ ] **Step 3: 在 repo 实现 `queryAppUsage`**

在 `apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/usage.ts` 末尾（`function integer` 之前）加：

```typescript
import type {
  AppUsageQueryInput,
  AppUsageQueryResult,
  AppUsageDayRow,
  AppUsageDayModelRow,
  AppUsageModelRow,
  AppUsageToolRow,
} from "@zcode/contracts";

// 说明：按本地日归桶用固定偏移 tzOffsetMs，dayIndex = floor((started_at + off)/DAY)。
// DST 跨日边界存在最多 1 小时误差，对用量统计可接受。
export async function queryAppUsage(
  db: DatabaseSync,
  input: AppUsageQueryInput,
): Promise<AppUsageQueryResult> {
  const { since, until, tzOffsetMs } = input;
  const DAY_MS = 86_400_000;

  const totals = db
    .prepare(
      `select
         coalesce(sum(computed_total_tokens), 0) as totalTokens,
         coalesce(sum(input_tokens), 0) as inputTokens,
         coalesce(sum(output_tokens), 0) as outputTokens,
         coalesce(sum(reasoning_tokens), 0) as reasoningTokens,
         coalesce(sum(cache_creation_input_tokens), 0) as cacheCreationTokens,
         coalesce(sum(cache_read_input_tokens), 0) as cacheReadTokens,
         count(*) as modelRequestCount,
         coalesce(sum(case when status = 'error' then 1 else 0 end), 0) as modelErrorCount,
         avg(time_to_first_token_ms) as avgTimeToFirstTokenMs
       from model_usage
       where started_at >= ? and started_at <= ?`,
    )
    .get(since, until) as Record<string, number | null>;

  const turnTotals = db
    .prepare(
      `select
         count(distinct session_id) as totalSessions,
         count(*) as totalTurns,
         avg(case when status = 'completed' then duration_ms else null end) as avgTurnDurationMs
       from turn_usage
       where started_at >= ? and started_at <= ?`,
    )
    .get(since, until) as Record<string, number | null>;

  const toolTotals = db
    .prepare(
      `select
         count(*) as toolCallCount,
         coalesce(sum(case when status = 'error' then 1 else 0 end), 0) as toolErrorCount
       from tool_usage
       where started_at >= ? and started_at <= ?`,
    )
    .get(since, until) as Record<string, number>;

  const models = db
    .prepare(
      `select
         model_id as modelId,
         coalesce(sum(computed_total_tokens), 0) as totalTokens,
         coalesce(sum(input_tokens), 0) as inputTokens,
         coalesce(sum(output_tokens), 0) as outputTokens,
         count(*) as requestCount
       from model_usage
       where started_at >= ? and started_at <= ?
       group by model_id
       order by totalTokens desc`,
    )
    .all(since, until) as AppUsageModelRow[];

  const tools = db
    .prepare(
      `select
         tool_name as toolName,
         count(*) as callCount,
         coalesce(sum(case when status = 'error' then 1 else 0 end), 0) as errorCount,
         avg(duration_ms) as avgDurationMs
       from tool_usage
       where started_at >= ? and started_at <= ?
       group by tool_name
       order by callCount desc`,
    )
    .all(since, until) as AppUsageToolRow[];

  const days = db
    .prepare(
      `select
         cast((started_at + ?) / ? as integer) as dayIndex,
         coalesce(sum(computed_total_tokens), 0) as totalTokens,
         0 as turnCount,
         0 as toolCallCount
       from model_usage
       where started_at >= ? and started_at <= ?
       group by dayIndex`,
    )
    .all(tzOffsetMs, DAY_MS, since, until) as AppUsageDayRow[];

  const turnDays = db
    .prepare(
      `select cast((started_at + ?) / ? as integer) as dayIndex, count(*) as turnCount
       from turn_usage
       where started_at >= ? and started_at <= ?
       group by dayIndex`,
    )
    .all(tzOffsetMs, DAY_MS, since, until) as Array<{ dayIndex: number; turnCount: number }>;

  const toolDays = db
    .prepare(
      `select cast((started_at + ?) / ? as integer) as dayIndex, count(*) as toolCallCount
       from tool_usage
       where started_at >= ? and started_at <= ?
       group by dayIndex`,
    )
    .all(tzOffsetMs, DAY_MS, since, until) as Array<{ dayIndex: number; toolCallCount: number }>;

  // 合并三类按日统计到同一 dayIndex
  const dayMap = new Map<number, AppUsageDayRow>();
  for (const row of days) {
    dayMap.set(row.dayIndex, { ...row, turnCount: 0, toolCallCount: 0 });
  }
  for (const row of turnDays) {
    const existing = dayMap.get(row.dayIndex) ?? {
      dayIndex: row.dayIndex,
      totalTokens: 0,
      turnCount: 0,
      toolCallCount: 0,
    };
    existing.turnCount = row.turnCount;
    dayMap.set(row.dayIndex, existing);
  }
  for (const row of toolDays) {
    const existing = dayMap.get(row.dayIndex) ?? {
      dayIndex: row.dayIndex,
      totalTokens: 0,
      turnCount: 0,
      toolCallCount: 0,
    };
    existing.toolCallCount = row.toolCallCount;
    dayMap.set(row.dayIndex, existing);
  }

  const dayModels = db
    .prepare(
      `select
         cast((started_at + ?) / ? as integer) as dayIndex,
         model_id as modelId,
         coalesce(sum(computed_total_tokens), 0) as totalTokens
       from model_usage
       where started_at >= ? and started_at <= ?
       group by dayIndex, model_id`,
    )
    .all(tzOffsetMs, DAY_MS, since, until) as AppUsageDayModelRow[];

  return {
    totals: {
      totalTokens: Number(totals.totalTokens ?? 0),
      inputTokens: Number(totals.inputTokens ?? 0),
      outputTokens: Number(totals.outputTokens ?? 0),
      reasoningTokens: Number(totals.reasoningTokens ?? 0),
      cacheCreationTokens: Number(totals.cacheCreationTokens ?? 0),
      cacheReadTokens: Number(totals.cacheReadTokens ?? 0),
      modelRequestCount: Number(totals.modelRequestCount ?? 0),
      modelErrorCount: Number(totals.modelErrorCount ?? 0),
      avgTimeToFirstTokenMs:
        totals.avgTimeToFirstTokenMs == null ? null : Number(totals.avgTimeToFirstTokenMs),
    },
    turnTotals: {
      totalSessions: Number(turnTotals.totalSessions ?? 0),
      totalTurns: Number(turnTotals.totalTurns ?? 0),
      avgTurnDurationMs:
        turnTotals.avgTurnDurationMs == null ? null : Number(turnTotals.avgTurnDurationMs),
    },
    toolTotals: {
      toolCallCount: Number(toolTotals.toolCallCount ?? 0),
      toolErrorCount: Number(toolTotals.toolErrorCount ?? 0),
    },
    models: models.map((m) => ({
      modelId: m.modelId ?? null,
      totalTokens: Number(m.totalTokens),
      inputTokens: Number(m.inputTokens),
      outputTokens: Number(m.outputTokens),
      requestCount: Number(m.requestCount),
    })),
    tools: tools.map((t) => ({
      toolName: t.toolName,
      callCount: Number(t.callCount),
      errorCount: Number(t.errorCount),
      avgDurationMs: t.avgDurationMs == null ? null : Number(t.avgDurationMs),
    })),
    days: [...dayMap.values()].sort((a, b) => a.dayIndex - b.dayIndex),
    dayModels: dayModels.map((d) => ({
      dayIndex: Number(d.dayIndex),
      modelId: d.modelId ?? null,
      totalTokens: Number(d.totalTokens),
    })),
  };
}
```

- [ ] **Step 4: 在 sqlite-session-store 代理新方法**

在 `apps/zcode-cli/packages/adapters/src/storage/session-store/sqlite-session-store.ts` 的 usage 代理段（约 203-217 行，`pruneUsage` 之后）加：

```typescript
async queryAppUsage(
  input: import("@zcode/contracts").AppUsageQueryInput,
): Promise<import("@zcode/contracts").AppUsageQueryResult> {
  return usageRepository.queryAppUsage(this.db, input);
}
```

> 若该文件顶部已 `import * as usageRepository from "./repositories/usage.js";` 并集中 import 了 contracts 类型，则改用顶部已有的具名 import 风格，与相邻方法保持一致。

- [ ] **Step 5: 运行测试至通过**

Run: `cd apps/zcode-cli && npx vitest run packages/adapters/tests/usage-query.test.ts`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/usage.ts \
        apps/zcode-cli/packages/adapters/src/storage/session-store/sqlite-session-store.ts \
        apps/zcode-cli/packages/adapters/tests/usage-query.test.ts
git commit -m "feat(adapters): aggregate app usage from sqlite usage tables"
```

---

## Phase 2 — builder + 协议

### Task 3: 纯函数 builder（先写测试）

**Files:**
- Test: `apps/zcode-cli/packages/bootstrap/tests/usage-stats-builder.test.ts`
- Create: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/usage-stats-builder.ts`

- [ ] **Step 1: 写失败测试**

创建 `apps/zcode-cli/packages/bootstrap/tests/usage-stats-builder.test.ts`：

```typescript
import { describe, expect, it } from "vitest";
import type { AppUsageQueryResult } from "@zcode/contracts";
import {
  buildAppUsageSnapshot,
  resolveTzOffsetMs,
} from "../src/zcode-protocol/usage-stats-builder.js";

const DAY = 86_400_000;

function emptyResult(): AppUsageQueryResult {
  return {
    totals: {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      modelRequestCount: 0,
      modelErrorCount: 0,
      avgTimeToFirstTokenMs: null,
    },
    turnTotals: { totalSessions: 0, totalTurns: 0, avgTurnDurationMs: null },
    toolTotals: { toolCallCount: 0, toolErrorCount: 0 },
    models: [],
    tools: [],
    days: [],
    dayModels: [],
  };
}

describe("buildAppUsageSnapshot", () => {
  it("computes summary, cache hit rate, error rates and pads heatmap days", () => {
    const until = 7 * DAY; // tzOffset 0 → dayIndex 7 == until 当天
    const since = until - 7 * DAY;
    const result = emptyResult();
    result.totals = {
      totalTokens: 1000,
      inputTokens: 100,
      outputTokens: 200,
      reasoningTokens: 0,
      cacheCreationTokens: 100,
      cacheReadTokens: 600,
      modelRequestCount: 10,
      modelErrorCount: 2,
      avgTimeToFirstTokenMs: 120,
    };
    result.turnTotals = { totalSessions: 3, totalTurns: 12, avgTurnDurationMs: 1500 };
    result.toolTotals = { toolCallCount: 20, toolErrorCount: 5 };
    result.models = [
      { modelId: "a", totalTokens: 800, inputTokens: 80, outputTokens: 160, requestCount: 8 },
      { modelId: "b", totalTokens: 200, inputTokens: 20, outputTokens: 40, requestCount: 2 },
    ];
    result.tools = [
      { toolName: "Read", callCount: 12, errorCount: 2, avgDurationMs: 50 },
      { toolName: "Bash", callCount: 8, errorCount: 3, avgDurationMs: 300 },
    ];
    // 连续两天活跃，末尾对齐 until 当天
    result.days = [
      { dayIndex: 6, totalTokens: 400, turnCount: 5, toolCallCount: 8 },
      { dayIndex: 7, totalTokens: 600, turnCount: 7, toolCallCount: 12 },
    ];
    result.dayModels = [
      { dayIndex: 7, modelId: "a", totalTokens: 500 },
      { dayIndex: 7, modelId: "b", totalTokens: 100 },
    ];

    const snapshot = buildAppUsageSnapshot(result, {
      range: "7d",
      timeZone: "UTC",
      tzOffsetMs: 0,
      generatedAt: until,
      since,
      until,
    });

    expect(snapshot.source).toBe("agent-db");
    expect(snapshot.summary.totalTokens).toBe(1000);
    // cacheHitRate = cacheRead / (input + cacheCreation + cacheRead) = 600/800
    expect(snapshot.summary.cacheHitRate).toBeCloseTo(0.75, 5);
    expect(snapshot.summary.modelErrorRate).toBeCloseTo(0.2, 5);
    expect(snapshot.summary.toolErrorRate).toBeCloseTo(0.25, 5);
    expect(snapshot.summary.totalSessions).toBe(3);
    expect(snapshot.summary.totalTurns).toBe(12);
    expect(snapshot.summary.activeDays).toBe(2);
    expect(snapshot.summary.currentStreakDays).toBe(2);
    expect(snapshot.summary.favoriteModel?.modelId).toBe("a");
    expect(snapshot.summary.favoriteModel?.share).toBeCloseTo(0.8, 5);

    // heatmap 覆盖 8 天（since..until inclusive），缺失日补 level 0
    const cells = snapshot.heatmap.weeks.flatMap((w) => w.days).filter((c) => c !== null);
    expect(cells.length).toBe(8);
    expect(snapshot.heatmap.maxTokens).toBe(600);

    // trend: until 当天有两个模型
    const lastDay = snapshot.dailyModelUsage.at(-1);
    expect(lastDay?.models.length).toBe(2);

    expect(snapshot.models[0].share).toBeCloseTo(0.8, 5);
    expect(snapshot.tools[0].errorRate).toBeCloseTo(2 / 12, 5);
  });

  it("resolveTzOffsetMs returns a finite offset for a named zone", () => {
    const off = resolveTzOffsetMs("UTC", 0);
    expect(off).toBe(0);
    expect(Number.isFinite(resolveTzOffsetMs("America/New_York", 0))).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/zcode-cli && npx vitest run packages/bootstrap/tests/usage-stats-builder.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 builder**

创建 `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/usage-stats-builder.ts`：

```typescript
import type { AppUsageQueryResult } from "@zcode/contracts";
import type {
  AppUsageHeatmap,
  AppUsageHeatmapCell,
  AppUsageHeatmapWeek,
  AppUsageRange,
  AppUsageSnapshot,
} from "@zcode/shared";

const DAY_MS = 86_400_000;

export interface BuildAppUsageOptions {
  range: AppUsageRange;
  timeZone: string;
  tzOffsetMs: number;
  generatedAt: number;
  since: number;
  until: number;
}

/** 用 Intl 计算 timeZone 在 atMs 时刻相对 UTC 的偏移（ms）。无法解析时回退 0。 */
export function resolveTzOffsetMs(timeZone: string, atMs: number): number {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const parts = dtf.formatToParts(new Date(atMs));
    const lookup = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    const asUtc = Date.UTC(
      lookup("year"),
      lookup("month") - 1,
      lookup("day"),
      lookup("hour"),
      lookup("minute"),
      lookup("second"),
    );
    return asUtc - Math.trunc(atMs / 1000) * 1000;
  } catch {
    return 0;
  }
}

function dayIndexToDate(dayIndex: number): string {
  // dayIndex*DAY 是「本地午夜当作 UTC」的时刻，取其 UTC 日历分量即本地日期。
  return new Date(dayIndex * DAY_MS).toISOString().slice(0, 10);
}

function levelFor(tokens: number, max: number): AppUsageHeatmapCell["level"] {
  if (tokens <= 0 || max <= 0) return 0;
  const ratio = tokens / max;
  if (ratio > 0.75) return 4;
  if (ratio > 0.5) return 3;
  if (ratio > 0.25) return 2;
  return 1;
}

export function buildAppUsageSnapshot(
  result: AppUsageQueryResult,
  opts: BuildAppUsageOptions,
): AppUsageSnapshot {
  const { totals, turnTotals, toolTotals } = result;

  const cacheDenom = totals.inputTokens + totals.cacheCreationTokens + totals.cacheReadTokens;
  const cacheHitRate = cacheDenom > 0 ? totals.cacheReadTokens / cacheDenom : 0;
  const modelErrorRate =
    totals.modelRequestCount > 0 ? totals.modelErrorCount / totals.modelRequestCount : 0;
  const toolErrorRate =
    toolTotals.toolCallCount > 0 ? toolTotals.toolErrorCount / toolTotals.toolCallCount : 0;

  // 按日 token 映射，用于 activeDays / streak / heatmap
  const dayTokenMap = new Map<number, { totalTokens: number; turnCount: number; toolCallCount: number }>();
  for (const d of result.days) {
    dayTokenMap.set(d.dayIndex, {
      totalTokens: d.totalTokens,
      turnCount: d.turnCount,
      toolCallCount: d.toolCallCount,
    });
  }

  const startDayIndex = Math.floor((opts.since + opts.tzOffsetMs) / DAY_MS);
  const endDayIndex = Math.floor((opts.until + opts.tzOffsetMs) / DAY_MS);

  let activeDays = 0;
  let currentStreakDays = 0;
  let streakBroken = false;
  for (let di = endDayIndex; di >= startDayIndex; di--) {
    const tokens = dayTokenMap.get(di)?.totalTokens ?? 0;
    if (tokens > 0) {
      activeDays++;
      if (!streakBroken) currentStreakDays++;
    } else if (!streakBroken) {
      streakBroken = true;
    }
  }

  const maxTokens = result.days.reduce((m, d) => Math.max(m, d.totalTokens), 0);

  // heatmap：从 startDayIndex 到 endDayIndex，按 7 天一周切片（与现有 GitHub 式一致）
  const weeks: AppUsageHeatmapWeek[] = [];
  let week: Array<AppUsageHeatmapCell | null> = [];
  for (let di = startDayIndex; di <= endDayIndex; di++) {
    const day = dayTokenMap.get(di);
    week.push({
      date: dayIndexToDate(di),
      level: levelFor(day?.totalTokens ?? 0, maxTokens),
      totalTokens: day?.totalTokens ?? 0,
      turnCount: day?.turnCount ?? 0,
      toolCallCount: day?.toolCallCount ?? 0,
    });
    if (week.length === 7) {
      weeks.push({ weekIndex: weeks.length, days: week });
      week = [];
    }
  }
  if (week.length > 0) {
    while (week.length < 7) week.push(null);
    weeks.push({ weekIndex: weeks.length, days: week });
  }

  const heatmap: AppUsageHeatmap = {
    startDate: dayIndexToDate(startDayIndex),
    endDate: dayIndexToDate(endDayIndex),
    maxTokens,
    weeks,
  };

  // trend：按日聚合 dayModels
  const dailyMap = new Map<number, Map<string | null, number>>();
  for (const dm of result.dayModels) {
    const inner = dailyMap.get(dm.dayIndex) ?? new Map();
    inner.set(dm.modelId, (inner.get(dm.modelId) ?? 0) + dm.totalTokens);
    dailyMap.set(dm.dayIndex, inner);
  }
  const dailyModelUsage = [];
  for (let di = startDayIndex; di <= endDayIndex; di++) {
    const inner = dailyMap.get(di);
    dailyModelUsage.push({
      date: dayIndexToDate(di),
      models: inner
        ? [...inner.entries()].map(([modelId, totalTokens]) => ({ modelId, totalTokens }))
        : [],
    });
  }

  // 模型排行 + favorite
  const totalModelTokens = result.models.reduce((s, m) => s + m.totalTokens, 0);
  const models = result.models.map((m) => ({
    modelId: m.modelId,
    totalTokens: m.totalTokens,
    inputTokens: m.inputTokens,
    outputTokens: m.outputTokens,
    requestCount: m.requestCount,
    share: totalModelTokens > 0 ? m.totalTokens / totalModelTokens : 0,
  }));
  const favoriteModel =
    models.length > 0
      ? { modelId: models[0].modelId, totalTokens: models[0].totalTokens, share: models[0].share }
      : null;

  const tools = result.tools.map((t) => ({
    toolName: t.toolName,
    callCount: t.callCount,
    errorCount: t.errorCount,
    errorRate: t.callCount > 0 ? t.errorCount / t.callCount : 0,
    avgDurationMs: t.avgDurationMs,
  }));

  return {
    range: opts.range,
    generatedAt: opts.generatedAt,
    timeZone: opts.timeZone,
    source: "agent-db",
    summary: {
      totalTokens: totals.totalTokens,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      reasoningTokens: totals.reasoningTokens,
      cacheCreationTokens: totals.cacheCreationTokens,
      cacheReadTokens: totals.cacheReadTokens,
      cacheHitRate,
      totalSessions: turnTotals.totalSessions,
      totalTurns: turnTotals.totalTurns,
      toolCallCount: toolTotals.toolCallCount,
      toolErrorRate,
      modelErrorRate,
      avgTimeToFirstTokenMs: totals.avgTimeToFirstTokenMs,
      avgTurnDurationMs: turnTotals.avgTurnDurationMs,
      activeDays,
      currentStreakDays,
      favoriteModel,
    },
    heatmap,
    dailyModelUsage,
    models,
    tools,
  };
}
```

- [ ] **Step 4: 运行测试至通过**

Run: `cd apps/zcode-cli && npx vitest run packages/bootstrap/tests/usage-stats-builder.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/zcode-cli/packages/bootstrap/src/zcode-protocol/usage-stats-builder.ts \
        apps/zcode-cli/packages/bootstrap/tests/usage-stats-builder.test.ts
git commit -m "feat(bootstrap): pure app usage snapshot builder"
```

---

### Task 4: 协议方法 `usage/stats`（schema + handler + dispatch + 宿主 agentService）

**Files:**
- Modify: `packages/shared/src/zcode-protocol/index.ts`
- Modify: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts`
- Modify: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server.ts`
- Modify: `packages/services/src/zcode-agent/zcodeAgentService.ts`（及其参数/接口类型定义文件）

- [ ] **Step 1: 在 shared 协议文件加方法与 schema**

在 `packages/shared/src/zcode-protocol/index.ts`：

(a) `zcodeProtocolMethods` 对象（约第 1687 行）内，在 `promptEnhance` 行附近加一项：

```typescript
  usageStats: "usage/stats",
```

(b) 在 schema 定义区（与 `zcodeSessionListParamsSchema` 同段，约第 1255 行附近）加入参 schema，并引用 Task 0 的 `appUsageSnapshotSchema`：

```typescript
import { appUsageSnapshotSchema, APP_USAGE_RANGES } from "../usage-stats.js";

export const zcodeUsageStatsParamsSchema = z
  .object({
    range: z.enum(APP_USAGE_RANGES),
    timeZone: z.string().optional(),
  })
  .strict();
export type ZCodeUsageStatsParams = z.infer<typeof zcodeUsageStatsParamsSchema>;

export const zcodeUsageStatsResultSchema = appUsageSnapshotSchema;
export type ZCodeUsageStatsResult = z.infer<typeof zcodeUsageStatsResultSchema>;
```

> 若 `index.ts` 已从 `../usage-stats.js` 导入其它符号，合并到同一条 import。

(c) 在方法→schema 契约映射对象（约第 1731 行，`[zcodeProtocolMethods.sessionList]: {...}` 同款）加：

```typescript
[zcodeProtocolMethods.usageStats]: {
  params: zcodeUsageStatsParamsSchema,
  result: zcodeUsageStatsResultSchema,
},
```

- [ ] **Step 2: 写 handler**

在 `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts`，仿 `listSessions`（约第 114 行）加：

```typescript
import {
  zcodeUsageStatsParamsSchema,
  // ...已有 import
} from "@zcode/shared";
import {
  buildAppUsageSnapshot,
  resolveTzOffsetMs,
} from "./usage-stats-builder.js";

const APP_USAGE_RANGE_DAYS: Record<string, number> = { "7d": 7, "30d": 30 };

export async function getUsageStats(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeUsageStatsParamsSchema, rawParams ?? {});
  const timeZone = params.timeZone ?? "UTC";
  const until = Date.now();
  const tzOffsetMs = resolveTzOffsetMs(timeZone, until);
  const rangeDays = APP_USAGE_RANGE_DAYS[params.range] ?? 30;
  const since = until - rangeDays * 86_400_000;

  if (!context.deps.sessionStore) {
    // 无 sessionStore（不应发生）：返回空快照而非抛错，便于 UI 显示空态。
    return buildAppUsageSnapshot(
      {
        totals: {
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          modelRequestCount: 0,
          modelErrorCount: 0,
          avgTimeToFirstTokenMs: null,
        },
        turnTotals: { totalSessions: 0, totalTurns: 0, avgTurnDurationMs: null },
        toolTotals: { toolCallCount: 0, toolErrorCount: 0 },
        models: [],
        tools: [],
        days: [],
        dayModels: [],
      },
      { range: params.range, timeZone, tzOffsetMs, generatedAt: until, since, until },
    );
  }

  const result = await context.deps.sessionStore.queryAppUsage({ since, until, tzOffsetMs });
  return buildAppUsageSnapshot(result, {
    range: params.range,
    timeZone,
    tzOffsetMs,
    generatedAt: until,
    since,
    until,
  });
}
```

> 确认 `context.deps.sessionStore` 的类型已包含 `queryAppUsage`（Task 1 已在 `UsageStorePort` 加）。若 `sessionStore` 的类型是组合接口，确保它继承/包含 `UsageStorePort`。

- [ ] **Step 3: 在 dispatch switch 加 case**

在 `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server.ts` 的 `dispatchRequest` switch（约第 99 行）内，仿 `sessionList` 加：

```typescript
    case zcodeProtocolMethods.usageStats:
      return await getUsageStats(this.context, request.params);
```

并在该文件顶部从 `./server-operations.js` 的具名 import 中加入 `getUsageStats`。

- [ ] **Step 4: 宿主 zcodeAgentService 加 `getAppUsageStats`**

在 `packages/services/src/zcode-agent/zcodeAgentService.ts`，仿 `listSessions`（约第 382 行）加方法：

```typescript
async getAppUsageStats(params: ZCodeAgentAppUsageParams) {
  const client = await getClient(params);
  return client.request(
    zcodeProtocolMethods.usageStats,
    { range: params.range, timeZone: params.timeZone },
    zcodeUsageStatsResultSchema,
  );
},
```

在该文件顶部 import 加 `zcodeUsageStatsResultSchema`（来自 `@zcode/shared`）。

定义参数类型 `ZCodeAgentAppUsageParams`（放在该 service 现有参数类型旁，复用其 `ZCodeAgentWorkspaceTarget` 基类）：

```typescript
export interface ZCodeAgentAppUsageParams extends ZCodeAgentWorkspaceTarget {
  range: AppUsageRange;
  timeZone?: string;
}
```

并在 `IZCodeAgentService` 接口（该 service 的接口声明文件）加：

```typescript
getAppUsageStats(params: ZCodeAgentAppUsageParams): Promise<AppUsageSnapshot>;
```

> `AppUsageRange` / `AppUsageSnapshot` 从 `@zcode/shared` 导入。

> **架构说明（实现者必读）**：usage 表位于全局 session 库（`~/.zcode/sessions/default.db`），任意 workspace 的 agent client 查询到的都是全应用范围数据。`getAppUsageStats` 沿用 `getClient(params)` 拿到当前活动 workspace 的 client 即可；它需要一个 `ZCodeAgentWorkspaceTarget`。宿主服务（Task 5）会传入当前活动 workspace 目标，与其它 `zcodeAgentService` 调用一致。

- [ ] **Step 5: 类型编译验证**

Run: `cd /Users/dev/workspace/z-code && npx tsc --noEmit -p packages/shared && npx tsc --noEmit -p apps/zcode-cli/packages/bootstrap`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/zcode-protocol/index.ts \
        apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts \
        apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server.ts \
        packages/services/src/zcode-agent/zcodeAgentService.ts
git commit -m "feat(protocol): add usage/stats method end to end"
```

---

## Phase 3 — 宿主服务换源

### Task 5: 重写 `usageStatsService.getAppUsageSnapshot` 走协议 + 删旧管线

**Files:**
- Modify: `packages/services/src/usage-stats/usageStats.ts`
- Modify: `packages/services/src/usage-stats/usageStatsService.ts`
- Modify: `packages/desktop/src/host/remoteWorkspaceServiceCollection.ts`
- Delete: `packages/services/src/usage-stats/usageStatsAggregator.ts`、`packages/services/src/usage-stats/repo/sessionUsageRepo.ts`、`packages/services/src/usage-stats/usageStatsSeries.ts`（存在则删）

- [ ] **Step 1: 更新接口入参类型**

`packages/services/src/usage-stats/usageStats.ts` 第 15 行 `getAppUsageSnapshot` 的入参 `AppUsageRequest` 现已是新类型（range: AppUsageRange，Task 0 已改）。确认该文件 import 的 `AppUsageRequest` / `AppUsageSnapshot` 来自 `@zcode/shared` 的新定义即可，无需改签名文字。

- [ ] **Step 2: 改 `createUsageStatsService` 依赖与方法体**

`packages/services/src/usage-stats/usageStatsService.ts`：

(a) 依赖接口加 `zcodeAgentService`：

```typescript
interface UsageStatsServiceDependencies {
  apiClient: ApiClient;
  modelProviderService: IModelProviderService;
  credentialService?: Pick<ICredentialService, "load">;
  env?: NodeJS.ProcessEnv;
  zcodeAgentService: Pick<IZCodeAgentService, "getAppUsageStats">;
  /** 解析当前活动 workspace 目标（与其它 agent 调用一致）。 */
  resolveActiveWorkspaceTarget: () => ZCodeAgentWorkspaceTarget;
}
```

(b) 顶部 import：

```typescript
import type { IZCodeAgentService, ZCodeAgentWorkspaceTarget } from "../zcode-agent/zcodeAgentService.js";
```

(c) 重写 `getAppUsageSnapshot`（替换第 45-52 行）：

```typescript
async getAppUsageSnapshot(request: AppUsageRequest): Promise<AppUsageSnapshot> {
  // App Usage 现读取 agent 数据库真实统计（model_usage/turn_usage/tool_usage），
  // 经 ZCode Protocol usage/stats 取回。不再读本地 session JSON 估算。
  const target = dependencies.resolveActiveWorkspaceTarget();
  return dependencies.zcodeAgentService.getAppUsageStats({
    ...target,
    range: request.range,
    timeZone: request.timeZone,
  });
},
```

(d) 删除文件顶部对 `readPersistedSessionFiles` / `buildUsageStatsSnapshot` 的 import。

- [ ] **Step 3: 删除旧本地聚合管线文件**

```bash
git rm packages/services/src/usage-stats/usageStatsAggregator.ts \
       packages/services/src/usage-stats/repo/sessionUsageRepo.ts \
       packages/services/src/usage-stats/usageStatsSeries.ts
```

> 若某文件不存在，跳过该条。再 `grep -rn "usageStatsAggregator\|sessionUsageRepo\|usageStatsSeries\|estimateTokensFromCharacterCount\|buildUsageStatsSnapshot" packages/` 清理所有残留 import/引用（含旧测试文件，一并删除或改写）。

- [ ] **Step 4: 在 host 注入依赖**

`packages/desktop/src/host/remoteWorkspaceServiceCollection.ts` 第 98-105 行改为：

```typescript
      .register(
        IUsageStatsService,
        createUsageStatsService({
          apiClient: localApiClient,
          modelProviderService: localModelProviderService,
          credentialService: localCredentialService,
          zcodeAgentService: params.connectionServices.zcodeAgentService,
          resolveActiveWorkspaceTarget: params.resolveActiveWorkspaceTarget,
        }),
      )
```

> `params.resolveActiveWorkspaceTarget` 若当前 params 未提供：在 `createRemoteWorkspaceServiceCollection` 的入参里加该函数，由调用方（已持有当前 workspace 上下文处）传入。沿用 `buildWorkspaceRef` / 现有 workspace target 构造逻辑——搜索本文件其它 `params.connectionServices.zcodeAgentService` 的调用上游，确认 workspace 目标来源后接入。

- [ ] **Step 5: 编译验证**

Run: `cd /Users/dev/workspace/z-code && npx tsc --noEmit -p packages/services && npx tsc --noEmit -p packages/desktop`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add packages/services/src/usage-stats packages/desktop/src/host/remoteWorkspaceServiceCollection.ts
git commit -m "feat(services): app usage reads agent db via protocol; drop local estimator"
```

---

## Phase 4 — UI 重绘

> 说明：UI 改动以 `AppUsageSnapshot` 新结构为准。所有 `formatCompactNumber` / `formatPercent` / `UsageMetricCard` / `UsageEmptyState` / `resolveModelLabel` 复用 `usageStatsUiParts.tsx` 现有导出。

### Task 6: 时间范围改 7d/30d + hook 类型

**Files:**
- Modify: `packages/ui/src/settings/usage-stats/usageStatsUiParts.tsx`
- Modify: `packages/ui/src/hooks/useUsageStats.ts`
- Modify: `packages/ui/src/settings/usage-stats/AppUsagePanel.tsx`

- [ ] **Step 1: `RANGE_OPTIONS` 改为 App Usage 范围**

在 `usageStatsUiParts.tsx` 找到 `RANGE_OPTIONS` 定义，改为：

```typescript
import type { AppUsageRange } from "@zcode/shared";
export const RANGE_OPTIONS: AppUsageRange[] = ["7d", "30d"];
```

- [ ] **Step 2: `useAppUsageStats` 形参类型改 `AppUsageRange`**

`packages/ui/src/hooks/useUsageStats.ts`：把 `useAppUsageStats(range: UsageStatsRange)`（第 163 行）改为 `range: AppUsageRange`，并在顶部 import 加 `AppUsageRange`（来自 `@zcode/shared`）。`useUsageStats` / `useCodingPlanUsageStats` 保持 `UsageStatsRange` / `CodingPlanUsageRange` 不动。

- [ ] **Step 3: 面板默认值与 tabs 类型**

`AppUsagePanel.tsx`：
- 第 32 行 `useState<UsageStatsRange>("all")` → `useState<AppUsageRange>("30d")`。
- import（第 17 行）`UsageStatsRange` → `AppUsageRange`。
- `AppUsageRangeTabs` 的 props 类型 `UsageStatsRange` → `AppUsageRange`（第 209-211 行）。

- [ ] **Step 4: 编译验证（局部）**

Run: `cd /Users/dev/workspace/z-code && npx tsc --noEmit -p packages/ui`
Expected: 仍会因后续 Task 未完成而报概要/热力图字段错误——本步只确认 range 相关无类型错误（忽略 summary/heatmap 字段类错误，下一 Task 修）。

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/hooks/useUsageStats.ts packages/ui/src/settings/usage-stats/usageStatsUiParts.tsx packages/ui/src/settings/usage-stats/AppUsagePanel.tsx
git commit -m "feat(ui): app usage range 7d/30d"
```

---

### Task 7: 概要卡片改用真实指标

**Files:**
- Modify: `packages/ui/src/settings/usage-stats/AppUsagePanel.tsx`

- [ ] **Step 1: 替换概要卡片网格**

把第 75-76 行 `favoriteModel` / `peakHour` 取值改为：

```typescript
  const summary = snapshot.summary;
  const favoriteModel = summary.favoriteModel;
```

把第 87-168 行整个 `<div className="grid ...">…</div>` 概要卡网格替换为下列 8 张卡（图标从 lucide-react 取，已在第 1-10 行导入；新增 `Wrench`、`AlertTriangle`、`Timer`、`Database` 到 import）：

```tsx
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <UsageMetricCard
          icon={Flame}
          label={intl.formatMessage({ id: "settings.usage.totalTokens" })}
          value={formatCompactNumber(locale, summary.totalTokens)}
          helper={intl.formatMessage(
            { id: "settings.usage.tokenBreakdown" },
            {
              input: formatCompactNumber(locale, summary.inputTokens),
              output: formatCompactNumber(locale, summary.outputTokens),
            },
          )}
        />
        <UsageMetricCard
          icon={Database}
          label={intl.formatMessage({ id: "settings.usage.cacheHitRate" })}
          value={formatPercent(locale, summary.cacheHitRate)}
        />
        <UsageMetricCard
          icon={Activity}
          label={intl.formatMessage({ id: "settings.usage.sessions" })}
          value={formatCompactNumber(locale, summary.totalSessions)}
        />
        <UsageMetricCard
          icon={MessageSquare}
          label={intl.formatMessage({ id: "settings.usage.turns" })}
          value={formatCompactNumber(locale, summary.totalTurns)}
        />
        <UsageMetricCard
          icon={Wrench}
          label={intl.formatMessage({ id: "settings.usage.toolCalls" })}
          value={formatCompactNumber(locale, summary.toolCallCount)}
          helper={intl.formatMessage(
            { id: "settings.usage.errorRate" },
            { rate: formatPercent(locale, summary.toolErrorRate) },
          )}
        />
        <UsageMetricCard
          icon={AlertTriangle}
          label={intl.formatMessage({ id: "settings.usage.modelErrorRate" })}
          value={formatPercent(locale, summary.modelErrorRate)}
        />
        <UsageMetricCard
          icon={Timer}
          label={intl.formatMessage({ id: "settings.usage.avgTtft" })}
          value={
            summary.avgTimeToFirstTokenMs == null
              ? "--"
              : `${formatCompactNumber(locale, Math.round(summary.avgTimeToFirstTokenMs))}ms`
          }
        />
        <UsageMetricCard
          icon={Activity}
          label={intl.formatMessage({ id: "settings.usage.favoriteModel" })}
          value={
            favoriteModel
              ? formatFavoriteModelMetricValue(resolveModelLabel(intl, favoriteModel.modelId))
              : "--"
          }
          valueSize="sm"
          helper={
            favoriteModel
              ? intl.formatMessage(
                  { id: "settings.usage.favoriteModelShare" },
                  { share: formatPercent(locale, favoriteModel.share) },
                )
              : undefined
          }
        />
      </div>
```

更新第 1-10 行 import：

```typescript
import {
  Activity,
  AlertTriangle,
  Database,
  Flame,
  MessageSquare,
  RefreshCcw,
  Timer,
  Wrench,
} from "lucide-react";
```

> 移除不再使用的 `CalendarDays`、`Gauge`、`TrendingUp`、`Zap`（除非热力图/趋势仍用到，按 tsc 报错为准）。

- [ ] **Step 2: 编译验证**

Run: `cd /Users/dev/workspace/z-code && npx tsc --noEmit -p packages/ui`
Expected: 概要相关字段错误消失；剩余热力图/趋势错误在后续 Task 修。

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/settings/usage-stats/AppUsagePanel.tsx
git commit -m "feat(ui): real-token summary cards for app usage"
```

---

### Task 8: 热力图改 30 天（字段适配）

**Files:**
- Modify: `packages/ui/src/settings/usage-stats/usageStatsUiParts.tsx`
- Modify: `packages/ui/src/settings/usage-stats/AppUsagePanel.tsx`

- [ ] **Step 1: `UsageHeatmap` props 与单元格字段适配**

`usageStatsUiParts.tsx` 中 `UsageHeatmap` 组件：
- props `weeks` 类型从 `UsageStatsHeatmapWeek[]` 改为 `AppUsageHeatmapWeek[]`（import 自 `@zcode/shared`）。
- 单元格 tooltip 与配色：用 `cell.totalTokens`（替换原 `totalEstimatedTokens`/`activityScore`），tooltip 文案改用新 i18n：

```tsx
title={intl.formatMessage(
  { id: "settings.usage.heatmapCell" },
  {
    date: cell.date,
    tokens: formatCompactNumber(locale, cell.totalTokens),
    turns: cell.turnCount,
  },
)}
```

- `level` 字段语义不变（0-4），配色映射保留。
- 删除对 `monthLabels` 的依赖（新结构无该字段）；若现组件渲染月份标签，改为不渲染或基于 `weeks[i].days[0]?.date` 自行推导（可选，30 天范围下月份标签意义不大，建议直接移除月份标签块）。

- [ ] **Step 2: 面板渲染处不变**

`AppUsagePanel.tsx` 第 170-176 行 `<UsageHeatmap weeks={snapshot.heatmap.weeks} .../>` 保持；确认 `snapshot.heatmap.weeks` 现为新结构（已是）。

- [ ] **Step 3: 编译验证**

Run: `cd /Users/dev/workspace/z-code && npx tsc --noEmit -p packages/ui`
Expected: 热力图字段错误消失。

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/settings/usage-stats/usageStatsUiParts.tsx packages/ui/src/settings/usage-stats/AppUsagePanel.tsx
git commit -m "feat(ui): 30-day token heatmap"
```

---

### Task 9: 趋势图改真实 token + 模型排行字段适配

**Files:**
- Modify: `packages/ui/src/settings/usage-stats/AppUsageDailyModelBarChart.tsx`
- Modify: `packages/ui/src/settings/usage-stats/AppUsagePanel.tsx`

- [ ] **Step 1: 趋势图取值改 `totalTokens`**

`AppUsageDailyModelBarChart.tsx`：把读取 `snapshot.dailyModelUsage[].models[].totalEstimatedTokens` 的地方改为 `totalTokens`（新 `AppUsageDailyModelItem` 字段）。分桶/堆叠逻辑不变。`snapshot.dailyModelUsage` 类型现为 `AppUsageDailyModelUsage[]`。

- [ ] **Step 2: 模型排行字段适配**

`AppUsagePanel.tsx` 的 `AppUsageModelRanking`（第 235-274 行）：
- `model.inputEstimatedTokens` → `model.inputTokens`
- `model.outputEstimatedTokens` → `model.outputTokens`
- `model.share` 不变；`resolveModelLabel(intl, model.modelId)` 不变。

- [ ] **Step 3: 编译验证**

Run: `cd /Users/dev/workspace/z-code && npx tsc --noEmit -p packages/ui`
Expected: 趋势/排行字段错误消失。

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/settings/usage-stats/AppUsageDailyModelBarChart.tsx packages/ui/src/settings/usage-stats/AppUsagePanel.tsx
git commit -m "feat(ui): real-token trend and model ranking"
```

---

### Task 10: 新增「工具使用」区块

**Files:**
- Modify: `packages/ui/src/settings/usage-stats/AppUsagePanel.tsx`

- [ ] **Step 1: 加 `AppUsageToolUsageSection` 组件**

在 `AppUsagePanel.tsx` 末尾加：

```tsx
function AppUsageToolUsageSection({ snapshot }: { snapshot: AppUsageSnapshot }) {
  const { intl, locale } = useZCodeIntl();
  const tools = snapshot.tools;
  const maxCalls = tools.reduce((m, t) => Math.max(m, t.callCount), 0);

  return (
    <section className="space-y-3 rounded-lg bg-surface p-4">
      <h3 className="text-sm font-medium text-foreground">
        {intl.formatMessage({ id: "settings.usage.toolUsageTitle" })}
      </h3>
      {tools.length === 0 ? (
        <UsageEmptyState
          title={intl.formatMessage({ id: "settings.usage.emptyTitle" })}
          description={intl.formatMessage({ id: "settings.usage.emptyDescription" })}
        />
      ) : (
        <div className="space-y-2">
          {tools.map((tool) => (
            <div
              key={tool.toolName}
              className="grid gap-2 border-b border-border/70 py-2 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center"
            >
              <div className="min-w-0">
                <div className="truncate font-mono text-sm text-foreground">{tool.toolName}</div>
                <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-border/40">
                  <div
                    className="h-full rounded bg-primary/70"
                    style={{ width: `${maxCalls > 0 ? (tool.callCount / maxCalls) * 100 : 0}%` }}
                  />
                </div>
              </div>
              <div className="text-xs text-foreground-subtle">
                {formatCompactNumber(locale, tool.callCount)}{" "}
                {intl.formatMessage({ id: "settings.usage.toolCallsUnit" })}
                {tool.avgDurationMs == null
                  ? null
                  : ` · ${formatCompactNumber(locale, Math.round(tool.avgDurationMs))}ms`}
              </div>
              <div className="text-right text-sm font-medium text-foreground">
                {intl.formatMessage(
                  { id: "settings.usage.errorRate" },
                  { rate: formatPercent(locale, tool.errorRate) },
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 2: 在面板渲染处插入区块**

在 `AppUsagePanel` return 内，第 179 行 `<AppUsageModelRanking snapshot={snapshot} />` 之后加：

```tsx
      <AppUsageToolUsageSection snapshot={snapshot} />
```

- [ ] **Step 3: 编译验证**

Run: `cd /Users/dev/workspace/z-code && npx tsc --noEmit -p packages/ui`
Expected: PASS（UI 包无类型错误）。

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/settings/usage-stats/AppUsagePanel.tsx
git commit -m "feat(ui): tool usage section"
```

---

### Task 11: i18n 文案（增删）

**Files:**
- Modify: UI 的中英文 message 文件（搜索 `settings.usage.totalTokens` 定位，通常 `packages/ui/src/i18n/messages/{zh,en}.*`）

- [ ] **Step 1: 定位 messages 文件**

Run: `grep -rln "settings.usage.totalTokens" packages/ui/src`
记下中/英两个文件路径。

- [ ] **Step 2: 新增 key（中文 + 英文都要加）**

新增以下 key（中文示例，英文文件填对应英文）：

```
"settings.usage.tokenBreakdown": "输入 {input} · 输出 {output}",
"settings.usage.cacheHitRate": "缓存命中率",
"settings.usage.turns": "对话轮次",
"settings.usage.toolCalls": "工具调用",
"settings.usage.errorRate": "错误率 {rate}",
"settings.usage.modelErrorRate": "请求错误率",
"settings.usage.avgTtft": "平均首字延迟",
"settings.usage.heatmapCell": "{date}：{tokens} tokens · {turns} 轮",
"settings.usage.toolUsageTitle": "工具使用",
"settings.usage.toolCallsUnit": "次",
```

英文文件对应：

```
"settings.usage.tokenBreakdown": "{input} in · {output} out",
"settings.usage.cacheHitRate": "Cache hit rate",
"settings.usage.turns": "Turns",
"settings.usage.toolCalls": "Tool calls",
"settings.usage.errorRate": "Error {rate}",
"settings.usage.modelErrorRate": "Request error rate",
"settings.usage.avgTtft": "Avg TTFT",
"settings.usage.heatmapCell": "{date}: {tokens} tokens · {turns} turns",
"settings.usage.toolUsageTitle": "Tool usage",
"settings.usage.toolCallsUnit": "calls",
```

- [ ] **Step 3: 删除不再引用的 key**

删除（确认无其它引用后）：`settings.usage.messages`、`settings.usage.currentStreak`、`settings.usage.longestStreak`、`settings.usage.peakHour`、`settings.usage.peakHourTokens`、`settings.usage.range.all`。

Run: `grep -rn "settings.usage.range.all\|settings.usage.peakHour\|settings.usage.messages\b" packages/ui/src`
Expected: 仅 message 文件自身命中（无组件引用），删之。

- [ ] **Step 4: 编译 + lint + 全量测试**

Run: `cd /Users/dev/workspace/z-code && npm run lint && npm test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/i18n
git commit -m "feat(ui): app usage i18n keys"
```

---

## 收尾验证

- [ ] **Step 1: 全量 lint + test**

Run: `cd /Users/dev/workspace/z-code && npm run lint && npm test`
Expected: PASS。

- [ ] **Step 2: 残留引用扫描**

Run: `grep -rn "estimateTokensFromCharacterCount\|totalEstimatedTokens\|activityScore\|readPersistedSessionFiles\|usageStatsAggregator" packages/ apps/ --include=*.ts --include=*.tsx`
Expected: 无业务代码命中（仅 spec/plan 文档或 Coding Plan monitor 自有的 `totalEstimatedTokens` 若存在则保留判断）。

- [ ] **Step 3: 手动联调（可选，按 verify 技能）**

启动应用，打开 设置 → 使用统计 → 应用用量，确认：7d/30d 切换、概要 8 卡有真实数值、30 天热力图、趋势真实 token、工具使用区块。

---

## 自检（计划 vs spec）

- **数据流（ZCode Protocol）**：Task 1-5 覆盖 contracts→adapters→bootstrap handler→shared schema→host service 全链路。✓
- **删除字符估算管线**：Task 0（类型）+ Task 5（删文件/引用）。✓
- **概要 8 卡（真实 token/缓存命中/会话/轮次/工具/错误率/TTFT/最常用模型）**：Task 7。✓
- **30 天热力图**：Task 3（builder weeks）+ Task 8（UI）。✓
- **真实 token 趋势**：Task 3（dailyModelUsage）+ Task 9。✓
- **工具使用区块**：Task 2（SQL）+ Task 3（tools）+ Task 10（UI）。✓
- **可靠性指标**：Task 2/3（errorRate/TTFT/durations）+ Task 7。✓
- **时间筛选 7d/30d 去掉「全部」**：Task 6 + Task 11（删 range.all）。✓
- **30 天保留期 / 空态**：handler 空 sessionStore 回退 + 现有 `UsageStatsErrorNotice`/`UsageEmptyState`。✓
- **Coding Plan / monitor 不动**：仅改 App Usage 路径，`UsageStatsRange`/`getSnapshot` 保留。✓
