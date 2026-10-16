# Todo 86：Provider 刷新职责与等待语义收口（草案）

> 状态：待讨论，未授权实施。2026-09-06 侧会话记录。
> 2026-09-09 归档：补交此前未跟踪的历史草案，不构成本轮实施授权或新增欠账。下文事实是 09-06 调查快照；后续已有 Todo99/100 的局部修复与调查、Todo101 的延期方向，未来重启讨论时须先对照最新代码去重。
> 本次只落盘，后续讨论确认方案；不打断 Todo 85 的恢复工作，不修改其执行记录。

## 问题与已核实事实

领取成功目前由活动页面调用 `providerSettingsService.refresh()`。该入口不仅刷新 Account Source，还强制刷新远端 Built-in，随后显式要求 Registry 重算。与此同时，Registry 已订阅 Account Source / Config Source 的变更。因此存在两种推动下游的方式；是否产生重复计算取决于调度，不能直接认定每次都计算两遍。

当前 `claimManualPlan()` 本身只请求领取接口并返回结果，没有通知 Account Source。不能只删页面调用而漏掉领取后的账号更新。

当前发现的生产调用入口：

- 领取成功：`ManualClaimPlanBanner.tsx`。
- 登录后、启动恢复时的账号套餐查询：`oauthProviderFamilySelectionRefresh.ts`。
- Root 公共刷新：`useRootProviderStateRefresh.ts`，供登录、启动恢复、退出登录及部分登录引导检查使用。
- 购买完成：`CodingPlanUpgradeDialog.tsx`。
- 设置页手动刷新：`useModelProviders.ts`。

服务链定位：`packages/provider/src/facades.ts`、`packages/services/src/model-provider/providerRuntime.ts`、`packages/provider/src/account-provider-service.ts`、`packages/provider/src/registry-service.ts`。实施前重新核对调用点及并行修改后的代码，不以本清单替代最新搜索。

## 倾向的原则，具体方案待确认

```text
领取 / 购买 / 登录等账号变化 -> 通知 Account Source 获取最新事实
配置保存                  -> Config Source 更新
                                 |
                                 v
                         Source 发布一致的新快照
                                 |
                                 v
                         统一订阅驱动 Provider 重算
                                 |
                                 v
                         Settings / Selection View 更新
```

业务通知应在合适的服务编排/依赖注入边界收口。UI 不直接访问 Account Source 具体实现，不恢复旧 Provider Store；不要求每个页面同时刷新 Source 和 Registry。

多数调用只需可靠触发更新，不必等待下游；少数调用确实需要最新 View，必须单独辨认。

## 明天重点讨论

### 1. 设置页手动刷新是否还需要

不预先决定保留或删除按钮。响应式只能传播客户端已经发现的变化，并不自动发现服务端变化。先查远端领取/购买、时间到期、临时失败恢复、远端 Built-in 发布等情况，现有事件、轮询和重新连接是否已经覆盖。

若自动更新足够可靠，可考虑取消手动入口；若仍有明确使用场景，说明用户到底刷新哪些源。即便保留，也不应成为第二条下游计算链。

### 2. 哪些调用需要等待，如何等待

逐入口分类：只触发、等待 Source、等待派生 View。重点检查登录后套餐选择、领取结果查询，以及任何 `await refresh()` 后立即读取 View 的逻辑。

```text
Source 完成更新 -> 发布变更 -> 下游计算完成 -> 最新 View 可读
       ^                           ^
  这两个完成时点不是同一个时点
```

若确需最新 View，研究复用现有 revision/快照机制等待对应源状态被应用，而不是额外重算或 sleep。不得拿旧 View 当新结果，也不能只等“下一次事件”：刷新结果未变化时可能不发事件，应立即确认已有结果满足要求。并发更新、失败、销毁时如何结束等待一起检查，但不预先引入复杂的新等待框架。

### 3. 领取权益查询是否不必要地依赖 Provider 全量刷新

固定 staging 的权益查询与 Provider 刷新并行；当前查询串在 Provider 全量刷新之后。检查账号访问身份实际依赖，避免无关的 Built-in 刷新失败阻断生效时间展示。不能为了并行而绕过凭据、账号身份或待生效权益的正确边界。

领取/购买成功是服务端事实，不因后续刷新失败改为领取/购买失败。

### 4. 接口及已有业务的收口范围

确定 `Settings.refresh()` 是删除、收窄还是改为请求源刷新并可等待结果；审查已有保存入口、启动初始化、远程 Provisioning 的重算/等待职责是否有相同问题，但不把本草案扩成远程同步重写。

## 与现有工作的边界及后续验证

- Todo 83 / 85 负责恢复正确的账号与领取行为；本草案讨论刷新职责，不推翻已确认的产品状态与架构。
- 活动预览防旧响应覆盖、登录变化后重新查询、轮询属于活动 UI 请求管理，应保留；不与 Account Overlay 更新混为一谈。
- 暂无持久化结构变更或数据迁移需求，不新增双份账号状态。
- 确认方案后先补有区分力的测试：账号变化能触发下游、领取不强刷 Built-in、无变化不会永久等待、需要新 View 的流程不读取旧结果、后置失败不改写领取成功。涉及交互再在约定的 MacBook Air 验证；不靠调用次数或实现细节堆叠测试。
- 本次未执行代码修改、测试或提交；以上是调查事实和待裁决方向，不是完成声明。
