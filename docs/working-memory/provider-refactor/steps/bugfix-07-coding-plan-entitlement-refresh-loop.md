# Bugfix 07：Coding Plan 权益刷新触发 Provider 设置页渲染死循环

> 状态：已完成
>
> 日期：2026-08-28
>
> 来源：macOS Provider Settings 实机出现 React #185（Maximum update depth exceeded）

## 1. 问题

用户进入模型设置中的 Coding Plan / Team Plan 后，整个 Provider 设置区可能被 Scoped Error Boundary
替换为 React #185 错误页。生产组件栈落在 `ModelProviderSection`，没有 SQLite、模型请求或
`reasoningLevel` 调用链。

这不是数据库损坏，也不是 `reasoningLevel -> variant` 的用量持久化映射导致。`ControlHintTooltip`
出现在组件栈顶部，是因为 Provider 设置布局的刷新按钮使用了该组件；相同 Tooltip/Select 结构的独立复现没有形成循环。

## 2. 根因

Family 权益编排重构后，`useProviderFamilyEntitlements` 每次 render 都返回新的普通对象；
`useCodingPlanEntitlements` 的最终 `useMemo` 又把整个 `zaiFamily`、`bigmodelFamily` 对象作为依赖，
使等价权益事实也失去引用稳定性。

Provider 导航由权益结果投影。权益对象每次变化都会重新创建导航项和 `selectedNavItem`。套餐访问刷新 effect
依赖整个 `selectedNavItem`，于是把“同一套餐的 loading/snapshot 展示更新”误判为“用户重新打开了套餐”。

```text
Family Hook 每次返回新对象
        |
        v
权益结果每次返回新对象
        |
        v
导航重新投影 selectedNavItem
        |
        v
套餐访问 effect 再次 refresh
        |
        v
权益 setState 再次 render
        |
        `------------------------> React #185
```

通用权益 Hook 在 freshness window 命中时仍会产生一次等价 state 对象，这会放大错误依赖，但不是本次根因；
本 Bugfix 不用通用 setState 防御掩盖 Provider 设置页的错误触发语义。

## 3. 修复原则

### 3.1 Family 权益结果按真实事实保持稳定

- `useProviderFamilyEntitlements` 的返回对象以实际 provider id、fingerprint、enabled 和四个权益结果字段为依赖；
- 输入与权益事实不变时，Family 结果和 `useCodingPlanEntitlements` 最终结果保持引用稳定；
- 保留统一 Family 编排，不退回 Z.ai / BigModel 两套重复实现。

### 3.2 套餐访问刷新只响应选择身份变化

```text
selectedPlanKey: null -> plan A  --> 刷新一次
selectedPlanKey: plan A -> plan A --> 不刷新
plan A 的 loading/snapshot 变化  --> 不刷新
selectedPlanKey: plan A -> plan B --> 刷新一次
```

- effect 只依赖 `selectedPlanKey` 和稳定的刷新函数；
- 不依赖包含额度、状态、Provider 投影等易变字段的整个 `selectedNavItem`；
- 不增加最大刷新次数、布尔锁、定时器或异常吞噬。

## 4. 测试

先写失败测试，再实现修复：

- 相同 Provider Settings View 与等价 connection selection 重新渲染时，权益 Hook 返回引用不变；
- Coding Plan 第一次被选中时触发一次 access refresh；
- 同一套餐对象被重新投影、权益 loading/snapshot 更新时不再次触发；
- Coding Plan 切换到 Team Plan 或另一个 Family 时恰好再刷新一次；
- API Key / Personal Provider 不触发套餐权益 access refresh；
- 现有 Z.ai、BigModel、Start Plan、Team Plan 权益查询与缓存身份测试继续通过。

## 5. 完成标准

- Provider 设置页不再出现由套餐权益刷新引发的 React #185；
- 套餐访问刷新语义从“对象变化”收口为“选择身份变化”；
- Family 重构后的 Hook 返回值具备稳定引用；
- 不修改 SQLite、`reasoningLevel`、Provider Registry 或模型执行链；
- UI 定向测试、`pnpm typecheck`、`pnpm lint` 和格式检查通过；
- macOS 开发运行时进入 BigModel/Z.ai 的 Individual/Team Plan 页面不再崩溃。

## 6. 实施结果

- Family 权益 Hook 现在只在真实 Provider、访问身份或权益事实变化时产生新引用；
- 套餐访问刷新从整个导航对象收口为稳定的 `selectedPlanKey`；
- API Key / Personal Provider 不触发套餐 access refresh，同一套餐的额度与 loading 更新也不重复刷新；
- 保留 Family 统一编排、Provider Registry、SQLite 和 `reasoningLevel` 既有边界，没有增加循环次数门禁或异常兜底；
- 相关 4 个测试文件共 242 条测试通过，根 `pnpm typecheck` 与 `pnpm lint` 通过；
- 全量单测通过 12,717 条；另有 2 条既存失败，分别位于 macOS notarize 脚本和 SessionPane
  draft prewarm admission，与本次 Provider 权益 Hook 改动无文件或调用链交集；
- 全仓 `pnpm fmt:check` 仍被既存 Electron fiddle HTML 语法和 GB2312 fixture 阻断，本次改动文件单独通过格式检查。
- 既有 `CTP-02` E2E 正好覆盖打开设置页与切换 Team Plan；本机生产构建通过，但 Linux 缺少
  `xvfb-run`，Chrome 会话在执行用例前退出，macOS 运行验证仍需在可启动桌面应用的环境补跑。
