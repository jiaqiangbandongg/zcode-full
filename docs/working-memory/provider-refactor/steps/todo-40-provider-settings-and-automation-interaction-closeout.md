# Todo 40：Provider 设置与 Automation 模型交互收口

> 验证归属更新（2026-09-09）：本文残余欠测/失败/人工晋级统一转交 [Todo102](todo-102-verification-debt-closeout.md)，关闭在本文中的独立验证排期；历史证据保留，转交不代表测试通过。

> 后续 Desktop 图形 E2E 欠测统一由 Todo 78 收口，本 Todo 不再单独排期。

> 状态：已完成（Desktop 实机 E2E 受当前 Linux 环境缺少 `xvfb-run` 阻塞）
>
> 日期：2026-08-28
>
> 来源：Provider Settings 实机体验、Team Plan 升级入口与 Automation 新建任务回归

## 1. 目标

本 Todo 收口五个已经完成裁决的交互问题，不新增 Provider、Model 或 Automation 中间抽象：

1. 恢复 Coding Plan 升级入口原有的 Family、个人/团队 Audience 与具体 Team Plan 三维意图；
2. Provider 设置页恢复标准 `max-w-4xl`，只保留 Model Config 弹窗的标准 `max-w-2xl` 加宽；
3. 删除把模型编辑、启停、增删和连接测试捆绑在一起的 `modelsReadOnly`；
4. Account Provider 只隐藏 Endpoint、API Schema 与账号凭据，模型继续使用标准 Effective Model 编辑能力；
5. Automation 不再存在 `inherit/default model` 虚拟态，新建任务直接固化具体模型和 reasoning。

## 2. Coding Plan 升级意图

```text
Selected Account Provider
├─ provider family  -> Z.ai / BigModel
├─ plan audience    -> personal / team
└─ team plan key    -> 具体 Team Plan（仅团队入口）
          |
          v
CodingPlanUpgradeDialog
          |
          v
Embedded Website URL / Bridge
```

- Team Provider ID 必须进入 Coding Plan 升级入口的规范化边界，不能在弹窗入口被归一化为 `null`；这不应把 Team Provider 加入静态套餐导航候选；
- `providerId` 继续决定官网 Family；
- `initialAudience` 继续决定个人或团队页；
- `initialTeamPlanKey` 继续表达用户点击的具体团队套餐；
- Status Card 不得把所有升级/续费入口写死为 `personal`；
- WebView 必须显式接收购买启动意图，Telemetry 的 `purchase_audience` 不能兼任路由协议；
- 管理入口继续使用 Family Spec 中的个人/团队管理地址，与购买 WebView 职责分离。

## 3. Provider 设置页模型行为

```text
model.builtin
├─ true  -> Model ID 固定、不可删除
└─ false -> Model ID 可编辑、可以删除

所有模型
├─ 可以编辑 Personal Model Config Overlay
├─ 可以切换 enabled
├─ 可以参与排序
└─ 存在正式测试 handler 时可以连接测试
```

- 删除 `modelsReadOnly` 及其从 Account Detail 到 Model Row 的全部传递；
- 删除模型测试对表单 API Key、`readOnly` 和 `model.executable` 的 UI 猜测门禁；
- 测试按钮只在存在正式测试能力时显示，只在请求进行中禁用；
- 执行失败由正式 Model/Registry 测试链返回明确错误；
- Account Team / Individual / Start 页面不展示 Endpoint、API Schema 或账号凭据；
- Account Provider 的模型列表直接展示 Effective Provider Config，并允许标准 Personal Overlay 编辑；
- Built-in API Key Provider 仍可展示并锁定 Built-in-owned Endpoint/API Schema，字段级只读能力不删除。

## 4. 布局

- Provider Settings 页面恢复共享 `max-w-4xl` 内容宽度；
- Model Config 弹窗保持 `max-w-2xl`，不继续扩大；
- 不通过扩宽整个页面修复弹窗或详情内部滚动；
- Desktop、Web 和窄窗口继续使用现有响应式与独立滚动结构。

## 5. Automation 具体模型

```text
Target Host ModelSelectionView ready
              |
              v
preferredSelection
              |
              v
具体 providerId / modelId
              |
              v
模型 Option Spec 的默认 reasoning
              |
              v
保存完整 modelSelection
```

- 删除 `INHERIT_MODEL_VALUE` 与“默认模型/跟随 Workspace”文案；
- 新建任务、缺少模型的旧编辑记录以及切换目标 Workspace 后，使用目标 Host 的
  `preferredSelection` 初始化具体选择；
- UI 始终显示具体模型和具体 reasoning；
- 用户选择模型后不再被后续 View 更新覆盖；
- 没有 `preferredSelection` 时保持明确不可提交状态，不创建隐式默认；
- Create 输入始终写入完整 `modelSelection`；Update 继续允许 `null` 仅作为现有协议的显式清理值，
  本表单不再生成该值；
- 所选模型变化后，reasoning 按目标模型 Option Spec 校正；Automation 使用模型默认档位，
  不复用辅助模型任务的最低档位规则。

## 6. 测试与完成标准

- 单测证明 Team Provider 可以打开对应 Family、Audience 与 Team Plan Key 的 WebView；
- 单测证明 Z.ai / BigModel、personal / team 的 URL 启动意图不串线；
- Provider 单测证明 Account 模型可编辑、可启停、可测试，Builtin 模型仍不可删除或改 ID；
- Automation 单测证明 `preferredSelection` 初始化、具体选择持久化、Workspace 切换和无可用模型失败态；
- Desktop E2E 覆盖 Team 升级入口、Account 模型编辑/测试，以及 Automation 无手动选模即可提交；
- 执行受影响单测、Desktop E2E typecheck、根 `pnpm typecheck`、`pnpm lint` 与 `git diff --check`；
- Review 确认不存在新的 Provider 权限 DTO、默认模型 sentinel 或第二套模型事实。

## 7. 实施结果

- Coding Plan 升级入口恢复 `providerId + audience + teamPlanKey`，Z.ai / BigModel 与个人/团队入口不再串线；
- Provider 设置页恢复 `max-w-4xl`，Model Config 弹窗保持 `max-w-2xl`；
- 删除 `modelsReadOnly` 及模型测试对表单 API Key、只读状态和 executable 的 UI 预判；
- Account Provider 继续隐藏 Endpoint、API Schema 与账号凭据，但模型使用标准编辑、启停和测试能力；
- Automation 删除 `inherit/default model` 虚拟态，使用目标 Host preferred 初始化并保存具体模型与 reasoning；
- Built-in 模型仍由 `model.builtin` 单独保证 ID 不可改、成员不可删除。

## 8. 验证记录

- Provider / Coding Plan / Automation 定向单测：318 项通过；
- 全量 Unit：1492 个测试文件、12730 项通过，另有 1 个测试文件 / 25 项既有 skip；
- `packages/ui` TypeScript：通过；
- Desktop E2E TypeScript：通过；
- 根 `pnpm typecheck`：通过；
- 根 `pnpm lint`：0 error（33 条既有 warning）；
- 本轮 28 个文件格式检查：通过；根 `pnpm fmt:check` 被仓库既有二进制 `gb2312.js` 和 Electron
  fiddle 的非法 HTML 阻塞，与本轮文件无关；
- `git diff --check`：通过；
- Automation Desktop E2E 已完成生产构建，但 WebDriver 启动阶段因本机缺少 `xvfb-run` 无法创建 Chrome
  session；这是测试运行环境阻塞，不是场景断言失败。实机交互仍需在具备显示环境的 macOS 或安装 Xvfb
  的 Linux 环境补跑。
