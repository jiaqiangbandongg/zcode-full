# Coding Plan Quota Reset 分支审查与联调记录

> 分支：`codex/feat-quota-reset-ui`（基准 `staging`）
> 审查日期：2026-08-12 ｜ 审查人：团队成员 + ZCode agent
> 状态：**分支审查记录**（随联调与修复进展更新）

## 0. 范围与方法

- 全量 diff：30+ 文件，+4798/-58（services / shared / ui / 测试 / spec）
- 方法：diff 分层精读 + 核心源文件全文核对 + 历史提交溯源（`git log -S`）+ 实跑验证
  （provider/hook/lib/组件测试 29+52 例、`pnpm typecheck`、`pnpm lint`）
- 自动化验证结论：本分支相关测试全绿、typecheck 通过、改动文件 lint 0 警告 0 错误

## 1. 架构快照（当前实现）

```text
UI 组件 (packages/ui/components/coding-plan-quota-reset/*)
  └─ useCodingPlanQuotaResetUi (hook, 60s 轮询 + inflight 去重 + 1.5s 缓存)
       ├─ zustand 窗口内共享（codingPlanQuotaResetUiBySource，不广播不持久化）
       ├─ lib/codingPlanQuotaResetUi（状态机纯函数 available/processing/completed）
       └─ IUsageStatsService ── BigModelUsageQuotaProvider
            ├─ Authorization: zcode JWT（credentials["zcodejwttoken"]）
            ├─ X-Bigmodel-Authorization: MaaS 登录态 JWT（credentials["oauth:bigmodel:access_token"]）
            ├─ TEAM scope: Bigmodel-Organization / Bigmodel-Project
            └─ GET /status  POST /opportunity  POST /use  POST /history/read
                   base: /api/v1/coding-plan/reset  （snake_case envelope，Unix 毫秒）
```

## 2. 联调契约变更记录（按时间线）

| 日期  | 变更                                                                                                                         | 提交         | 说明                                                                                                                   |
| ----- | ---------------------------------------------------------------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------- |
| 08-12 | `X-Bigmodel-Authorization` 由 Coding Plan API key 改传 **MaaS 登录态 JWT**（`oauth:bigmodel:access_token`，直传不套 Bearer） | `6a06e7e8dd` | 后端按 JWT 识别用户；provider 解析只剩「确认 Coding Plan 已配置 + 推导 Team scope」两个用途；Team 不再复制项目 API key |
| 08-12 | envelope 业务错误的 error message 追加 ` (x-request-id:xxx)`                                                                 | `3cc99c4f69` | RPC FAIL 日志与 UI warn 可直接按 request-id 与后端对账；前缀契约不变；无该 header 时 message 原样                      |

## 3. 联调运行时观察（`~/.zcode/v2/logs/2026-08-12.log`）

- 当日 500+ 条 `[coding-plan-reset] status refresh failed`，**无一次成功**。
- 错误演进：`bigmodel_coding_plan_api_key_required`（11-13 点，key 未就位）→ 2007（主）+ 3101/429/zcode_jwt_required 混合。
- **JWT 修复后（16:07 bundle / 16:14 进程）2007 依旧**（41 条，含 16:26:28.680 最新一条），
  且 0 条 `maas_jwt_required`（守卫未触发）⇒ 请求已带 MaaS JWT 发出，**2007 属后端 → MAAS 链路问题**，待后端按 request-id 排查。
- 429 共 11 次：四接口限频下 60s 轮询本不该触发，疑似多入口/多 tab 并发重放，频率低暂不阻塞。

## 4. 静态审查问题清单

### ✅ 本次已修复（1）

1. **spec 与实现脱节** — 已修复
   `docs/coding-plan-quota-reset-ui.md` 已改为当前事实：UI 不维护 `nextTryAt` 或裸 429 的本地冷却；
   无机会时由下一次 60 秒可见轮询重新判断。Service 仍保留 `nextTryAt` 映射，作为接口契约和联调可观测字段。

### 🟡 建议修复（4）

2. **use 已接受但 2.5s 未确认 → 误报「重置失败」** — `useCodingPlanQuotaResetUi.ts:653-676`
   后端已核销、仅 status 确认超时即走失败分支（toast + 恢复 available），60s 后轮询又会 completed。
   建议 `useAccepted` 分支与失败分支区分文案/时长。
3. **乐观覆盖 100% 的停留时长取决于 `onEntitlementRefresh`** — `codingPlanQuotaResetUi.ts:272-284`
   `quotaOverridePending` 只有刷新成功才置 false；调用方未传回调或刷新链路失败时，
   quota 卡在 completed 期间持续覆盖为 100% 剩余（假数据）。需核对全部挂载入口的接线。
4. **未读旧历史的「迟到 completed」** — 产品语义确认项
   `has_unread_history` 不区分几秒前/隔夜；隔夜首次挂载仍进 completed（提示+短暂覆盖 100%），
   lib 的既有 bugfix 只防住 `has_unread_history=false` 的纯旧历史。
5. **裸 429 的冷却兜底在客户端已整体移除**（`a80ef94c6d`）——需与后端书面确认：
   客户端每 60s 换新幂等键重试 /opportunity 的行为被后端接受（超时重复发放的额度风险由后端承接）。

### 🔵 可选优化

6. `buildTypeController` 每渲染重建对象（`useCodingPlanQuotaResetUi.ts:686-705`）——当前消费方仅解构字段无害；建议 useMemo 或注释约定。
7. confetti `zIndex:"100"` 硬编码（`codingPlanQuotaResetConfetti.ts:30`）——未按 DESIGN.md 层级 token 化。
8. `formatCountdown` 的 `locale === "zh-CN"` 硬编码（`CodingPlanQuotaResetOpportunity.tsx:16`）。
9. hook 700 行 + `eslint-disable max-lines`；建议补 1 个「429/3301 后轮询不中断、终态正确」回归测试。
10. 券到期瞬间本地时钟与下轮 status 过滤之间的 60s 窗口内点击 use 会被 MAAS 拒绝（2007 toast）。

### 检查通过项

- 测试/typecheck/lint 全绿；i18n en-US/zh-CN key 完全对齐；日志规范合规（UI→`@/logger.js`，services→`createServiceLogger`）；
  DESIGN.md token 合规、confetti 双主题 + `prefers-reduced-motion` 防御；
  effects 依赖/清理完整、WeakMap 缓存无泄漏、UUID 三级降级正确；
  FIVE_HOUR/WEEK 双类型 `ownsUnread` 归属逻辑正确；分层边界无违规；提交符合 Conventional Commits。

## 5. 接口正常后的残余风险推演（2026-08-12 分析）

主流程闭环成立；以下为接口全部正常时仍可能暴露的问题，已含于第 4 节，此处只列联调用例优先级：

| 优先级 | 用例                             | 预期验证点                                                         |
| ------ | -------------------------------- | ------------------------------------------------------------------ |
| P0     | 点「重置」→ 立即发消息           | MAAS 核销后新额度是否立即可消费（UI 乐观 100% 与真实限流的一致性） |
| P0     | use 成功但 status 确认慢         | 是否复现「先失败 toast 后 completed」的矛盾反馈                    |
| P1     | 隔夜未读历史首挂载               | completed 判定与 100% 覆盖闪变是否符合产品预期                     |
| P1     | 双窗口同时点「重置」（2 券场景） | MAAS 最早过期核销是否导致双券消耗，产品语义确认                    |
| P2     | status 接近过期券点击            | 到期瞬间 use 被 MAAS 拒绝的 toast 体验                             |

## 6. 后端对齐遗留问题

1. manual/auto 核销来源：status 接口无法区分（MAAS query 不带来源，ZCODE status 不读自 MySQL 流水）。
   若产品要求展示区分来源，方案为「按 scope 查最近一条 use 流水 + used_at 精确等值匹配 + null 兜底」；
   后端称「不好区分」，待按真/伪困难清单（见对话记录）继续推进或降级为前端本地推导。
2. 2007 定位：等后端按 16:26:28.680 / `GET /status` / personal scope 查网关日志；
   新提交 `3cc99c4f69` 之后可直接按日志内 x-request-id 对账。
