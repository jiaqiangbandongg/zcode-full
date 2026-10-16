# Todo 73：侧栏账号套餐标签与个人／团队权益解耦

> 验证归属更新（2026-09-09）：本文残余欠测/失败/人工晋级统一转交 [Todo102](todo-102-verification-debt-closeout.md)，关闭在本文中的独立验证排期；历史证据保留，转交不代表测试通过。

> 侧栏图形 E2E 欠测已统一转入 Todo 78；本 Todo 保留功能实现和单测记录。

> 状态：已完成（相关单测、类型检查与 lint 通过；桌面图形 E2E 待 Mac 环境复跑）。
>
> 来源：2026-09-03 MacBook Air 实机反馈，左下角用户名旁的个人等级／Team 标签消失。
>
> 关系：Provider Account Access 消费方收尾；不依赖 Todo 68–72 的实现，不在本次落盘中修改代码。

## 1. 已确认的问题与证据

标签组件仍在，不是设计师 `fix/model-settings-ui-polish` 分支删除了标签，也不是本次发现的 CSS 问题。

Air 的 `~/.zcode/v2/logs/2026-09-03.log` 在 15:51:36.836 记录的账号同步结果：

- `account:bigmodel-individual-coding-plan.access.entitled = false`；
- `account:bigmodel-team-coding-plan.access.entitled = true`。

同期团队额度查询成功。说明账号确实有团队权益，不能把标签消失解释成没有套餐。
本次证据为日志与代码，尚未完成修复后 Air 验证，也未取得当前组件内存状态的 CDP 快照。

`WorkspaceSidebarFooterUsageSummary.tsx` 用 Individual Provider 调用
`resolveEntitledAccountProviderAccessFingerprint()`，却把这个 fingerprint 当作
`useEnterpriseCodingPlanProducts()` 的 enabled 前提。没有个人权益时返回空字符串，团队查询被关闭。
随后 `subscribedTeamProducts` 为空，头像徽标返回 null。Z.ai 存在对称问题。

```text
没有个人套餐权益
        |
        v
Individual fingerprint 为空
        |
        v
Team pricing 查询被禁用
        |
        v
Team 标签的数据为空，即使 Team Provider.entitled = true
```

历史上保留了个人 Provider 查询门禁；Provider 重构拆分个人／团队身份后没有同步解耦。
`bec05c983c` 又将读取接口统一收紧到 entitled 语义，当前错误依赖仍然存在。
不是要放宽 `resolveEntitledAccountProviderAccess()`，而是调用方应读取正确产品的事实。

## 2. 确认的行为与状态归属

```text
当前账号 Family + Ready ProviderSettingsView
        |
        +--> Individual access.entitled + 个人等级查询 --> 个人等级标签
        |
        `--> Team access.entitled --------------------> Team 标签候选

显示优先级：已确认的个人等级优先，否则按既有加载规则显示 Team；都没有则不显示。
```

- Team 标签直接消费同一 Family 的 Team Provider `effectiveConfig.access.entitled`；不要求有个人套餐、
  当前选中 Team、模型可执行、API Key，亦不以 pricing 成功作为账号团队身份的前提。
- 个人等级继续用既有个人 entitlement snapshot 与等级格式化，不新增等级推断或替代文案。
- 保留既有个人查询加载期间的优先级保护；未 Ready／读取失败不视作已确认没有权益。
- 当前账号 Family 隔离不变，切换 Family、退出登录、权益刷新后重新派生标签；不显示其他 Family 的旧 Team 状态。
- 标签只是展示，不回写 Account Overlay、不改变模型选择／凭据／额度，也不新增持久化状态或轮询。
- Team pricing 仍负责组织、项目、价格及升级入口等信息；不能因为头像不再依赖它，就删除所有相关查询。

## 3. 影响面（Impact Brief）

模式：planning；层级：presentation / validation。范围限账号套餐标签及其共用 hook 的必要调整。

| 入口／优先级 | 共享实现与数据 | 本次边界 |
| --- | --- | --- |
| 头像标签，must-inspect | `WorkspaceSidebarFooter` → `useWorkspaceSidebarFooterUsageSummaryState` → `resolveSidebarFooterProfilePlanBadge` | 改为独立读取个人／团队事实，保留现有样式与国际化 |
| Footer 额度与升级，must-inspect | 同一 UsageSummary hook、`teamSources`、`currentUsageSource` | Team 查询不依赖个人权益；组织／项目来源不退化成个人来源 |
| Provider Settings 套餐卡，should-inspect | Account Access helper、enterprise pricing hook | 保持现有账户与套餐卡行为，不全局放宽 helper |
| Desktop／Web／手机／远程，invariant-only | 已有 hooks、服务注入与 Family 边界 | 复用当前账号事实来源，不新增 runtime 或直连平台 API；不改任务 continuous/replayable 链路 |

权威事实来自账号服务，经 Account Overlay / ProviderSettingsView 投影；等级和价格保留各自已有服务与缓存。
标签没有 Composer 草稿、默认模型继承、提交命令或持久化落点。不同入口共享数据，不共享所有显示条件。

本次无可用 codegraph 工具，证据采用上一轮直接源码、调用方和 git history 核对；范围为 Footer 到 hooks/helper 两层。
既有测试 `packages/ui/test/workspaceSidebarFooterWebRemoteControlTooltip.test.ts` 已覆盖标签规则，
但不能替代“只有团队权益时，上游实际送入 Team 事实”的组件／hook 回归。

Graph drift / proposed delta：`capability.plan-entitlements` 应补充 Footer 标签入口及 Team 不依赖 Individual 的不变量。
图谱文件当前被另一任务修改，暂不并行编辑；实施时同向补齐并执行图谱完整性检查。
关联事实文档 `docs/usage-stats-app-coding-plan-split.md` 的旧 Provider ID / enabled / apiKey 描述不是当前契约，
不据此恢复旧设计；本 Todo 不扩展为整份使用统计设计重写。

## 4. 执行清单

- [ ] 先补回归：真实形状 ProviderSettingsView 中个人 false／团队 true，挂载 Footer，断言 Team 标签出现。
- [ ] 分别读取同一 Family 的个人／团队 Account Access，修正 badge 输入和团队查询门禁，移除误导性变量／注释。
- [ ] 检查 `teamSources` 等 memo 的依赖：读取 Team Access 必须订阅 Team 事实变化，不能只依赖 Individual Access。
- [ ] 保留额度／升级入口所需 pricing 查询；无个人权益时也能正常构建已订阅团队项目，不增加重复查询。
- [ ] 更新相关 spec／图谱与测试，明确 Account 身份、等级、项目价格是不同事实，不新建一套状态模型。
- [ ] 补交互 E2E，执行受影响单测、`pnpm typecheck`、`pnpm lint`；在 MacBook Air 验证并记录提交号、截图和脱敏日志。

## 5. 验收用例与交接

已确认维度仅为 Family、个人／团队权益、加载／刷新状态；不展开模型、reasoning、任务队列的无关组合。

| Case | 设置与动作 | 预期与证据 |
| --- | --- | --- |
| 73-01 | BigModel 个人 false、团队 true；冷启动侧栏 | 显示 Team；组件／hook 回归 + E2E + Air |
| 73-02 | Z.ai 同样只有团队权益 | 显示 Team；组件／hook 回归 |
| 73-03 | 有个人等级，分别搭配有／无团队权益 | 均优先显示个人等级；已有规则回归 |
| 73-04 | 两者均无权益，或只有 Start Plan | 不伪造个人等级／Team；单测 |
| 73-05 | 从有 Team 的 Family 切到另一无权益 Family，或退出登录 | 不残留旧 Team 标签；组件测试 |
| 73-06 | 个人查询加载、Provider View 未 Ready／失败，再恢复；团队权益单独变化 | 不把未知当作确定无权益，恢复后按最新事实显示，不依赖刷新整个页面 |
| 73-07 | 只有 Team 时打开 Footer 额度／升级入口；pricing 失败 | 成功时保留正确组织／项目；失败沿用既有错误处理，不抹掉已确认的 Team 身份 |

剪枝：无模型请求，不新增 provider replay fixture；不变更 Session/Submission，不扩展对话状态空间。
E2E 在现有账号／Provider fixture 基础上控制权益返回，等待可观测状态，不用固定 sleep。
浅／深主题、中／英文与窄屏做代表性检查，不重做标签视觉设计。远程场景保持既有账号来源隔离。
用例、coverage 与 E2E 状态均为 planned，实施时按 e2e-case-lifecycle 归档；不得把本次日志调查写成修复验证通过。
当前没有需要用户再次裁决的事项。详细测试文件落点和 Air 执行时间在实施时确定。
