# Todo 98：恢复 Built-in Option Map 的结构排版

> 状态：已完成并复审；2026-09-09。含实跑发现、用户批准的键盘拖拽隔离小修。
> 收尾：开发入口已关闭；残余多端验证归 [Todo102](todo-102-verification-debt-closeout.md) V102-04，pending 人工晋级及 settings fixture 校验工具缺口归 V102-05，不在本文独立挂账。
> 风格规范：[Option Map 写作风格](../design/model/option-map-writing-style.md)。

## 1. 问题与目标

Todo66 已要求复杂 Map 保留换行和缩进。`9b0f11e996` 实施 Todo95 时简化了逻辑，却将部分嵌套 Map 压成单行；设置页原样展示源字符串，因此出现截图中的长行回归。此前请求等价测试没有覆盖真实 Built-in 字符串的展示排版。

目标：保留当前简化逻辑，恢复嵌套对象的结构化排版；简单三目仍同行。检查全部 Built-in Option Map，包含专用及 API 兜底，不只补截图里的一个型号。

## 2. 范围和改造边界

- 主体只修改 `config/provider/zcode-builtin.json` 中需要整理的 Map 排版，并按既有发布契约更新 revision；补必要测试和验证记录。唯一追加产品代码改动为下述已批准键盘拖拽隔离。
- 不恢复冗余分支，不改变表达式 AST、合法输入的请求结果、字段省略/null、模式、预算或上限。这是本次修复的改造约束，不是写作风格定义。
- 不修改档位名称/values、Selection 迁移、规则匹配、优先级、Overlay 或 UI 编辑器格式/保存行为；Todo95C 独立提交，不混入本项排版差异。
- 不新增 Formatter、DSL 或运行时格式转换；不重排 Personal Map，不兼容或迁移未发布旧配置。

### 2026-09-09 实跑追加裁决：键盘拖拽隔离

F98-03 在 Pro 真实键入空格时复现：弹窗的 React Portal 键盘事件冒泡到背景模型行，KeyboardSensor 吃掉空格并触发排序写入，随后保存因 revision 变化失败。指针传感器已有交互目标隔离，键盘未复用。

用户批准纳入本轮小修：键盘启动拖拽复用已有控件/弹窗隔离规则；输入和弹窗不启动背景排序，模型行自身仍支持键盘拖拽。不改变 Map 格式、保存版本校验、排序提交规则，也不扩大为拖拽系统重构。F98-03 保留真实键入空格和原文保存断言；补组件级键盘与 Portal 负例、模型行键盘正例。

## 3. 精简影响分析（planning / presentation）

| 入口 | 共享实现与展示状态 | 来源、校验和保存边界 |
| --- | --- | --- |
| 添加模型 | Model 编辑草稿 → ProviderModelSettingsGroups → JsonSlotEditor | Built-in 继承值作 placeholder；显式草稿作 value；沿用原校验与保存，不因查看固化推荐值 |
| 编辑模型 | 同一组控件；Personal/固定配置与继承显示不同 | Settings Facade/ConfigService 仍负责保存 Personal Overlay；取消不写盘 |
| Desktop / Web / 手机设置 | 共用上述 UI | 同版本配置应保留相同换行，窄屏软换行不替代源字符串缩进；不涉及发布 Web 或修改 attachment |

共享的是字符串展示，不统一或改变添加/编辑、继承/固定的草稿和提交语义。

分级：must-inspect 为 Built-in Map 源字符串；should-inspect 为 `ProviderModelSettingsGroups.tsx`、`ProviderModelMetadataFields.tsx` 的 value/placeholder；invariant-only 为 Personal 保存与 Model 执行器；evidence-only 为 Provider Node、Map、UI 展示及设置 E2E 测试。

代码证据：`JsonSlotEditor` 直接使用 `value={value}`、`placeholder={effectiveValue}`，没有格式化步骤。codegraph 本环境不可用，采用定向配置差异和直接调用阅读，未声称完成索引 depth-2 扫描。未发现需新增的业务 surface/owner；图谱仅补规范/本 Todo 引用，无产品关系变更。

## 4. 已确认决策与用例

用户裁决：对象展开、两空格缩进、简单三目同行；风格与改造约束分开。无待确认问题。

维度只保留：嵌套/简单/复杂分支 × 专用/兜底来源 × placeholder/个人输入。不展开账号、套餐或所有主题/语言/设备的全组合；它们不改变本次源文本格式，桌面和窄屏各保留展示证据。

| Case | Setup / Action | 必须断言 | 计划证据 |
| --- | --- | --- | --- |
| F98-01 | 读取真实 Built-in 代表性嵌套 Map、复杂分支及简单 Map | 对象层级换行、两空格缩进、简单三目同行；简单 maxOutput Map 不机械展开 | 配置级回归测试，不能只用手写多行 fixture |
| F98-02 | 对修前/修后 Map 编译并核对配置差异 | 表达式结构不变；Map 排版及 revision 外无配置变化；已有请求测试通过 | 复用现有编译/等价测试；不新增持久化的全量旧配置快照或大型证明框架 |
| F98-03 | 设置页添加/编辑，展示继承 Map；输入个人排版后取消/正常保存 | 继承换行保留；个人输入不重排；查看/取消不产生覆盖；正常保存沿用原边界 | 共用 UI 测试 + 代表性 Electron E2E/截图，覆盖桌面和窄屏布局 |

当前 catalog/coverage 合并记录在本表；实施时复用 `providerModelMetadataDialog.test.ts` 和现有设置 E2E 的最近用例，按 e2e-case-lifecycle 补对应 case/manifest，不复制整套矩阵、不自动晋级 pending。测试先行，使用隔离配置、不要求真实账号/模型请求，不用 sleep 判断就绪；真实手机/Web 未运行须明确记录。

## 5. 执行顺序与验收

1. 先补 F98-01 的真实配置排版红灯及 F98-03 必要展示断言。
2. 整理受影响 Map，更新发布 revision；核对只有排版变动，没有逻辑简化或改名夹带。
3. 跑现有 Map/Provider 配置单测和相关 UI/E2E；执行 `pnpm typecheck`、`pnpm lint`、`git diff --check`。
4. 对照风格规范逐条复审，保存结构展示截图、测试结果和未验证范围，再提交并更新状态。

完成需同时有源字符串/展示排版证据和行为不变证据，不以 Todo95 的请求测试通过替代本项验收。

## 6. 实施、验证与逐项复审

- F98-01：先对真实 Built-in 写排版断言并确认红灯；整理 65 条 Map 中的 51 条，revision 12 → 13。嵌套对象展开、两空格缩进、简单三目同行，简单输出上限 Map 保持紧凑。
- F98-02：以本项前的 `9cd1ae31dd` 为基线，逐条解析全部 65 条 Map，去除源位置后 AST 完全一致；505 组求值结果相同。将 Map 字符串和 revision 还原后，整份配置深比较完全一致。没有夹带 values、匹配顺序、Provider 或模型能力修改；未保留临时排版脚本或新运行时 formatter。
- F98-03：SSR 验证继承 placeholder 与个人 value 原样展示。Pro 隔离副本实跑 `desktop-e2e-20260909-125010-082`，SC90-01 / F98-03 **2/2 通过**。编辑继承值不固化；键盘输入个人 Map 的连续空格保留；取消不写盘；保存后原样读回；添加取消不写盘。1200px / 390px 实际截图确认控件不溢出、结构换行保留，窄屏长三目按现有 textarea 自然软换行。
- 追加 Bug：修前 Pro `desktop-e2e-20260909-124116-723` 日志显示输入期间 `reorderPersonalModels` 先成功，随后保存 `expected 1 / current 2`；`desktop-e2e-20260909-124340-109` 直接断言抓到两个空格丢失。组件测试 7 类控件/Portal 红灯后，复用现有交互目标判定隔离键盘启动，7 类负例及模型行键盘启动正例均通过；没有绕开版本校验、模拟粘贴或改写用户 Map 来掩盖问题。
- 本地相关 Provider / Provider Node / Option Map / UI 共 **29 文件、422 测试通过**；根 `pnpm typecheck`、`pnpm lint`（39 存量警告 / 0 错误）及 diff 检查通过。测试和产品代码同步更新。
- 抽象复审：UI 只显示源字符串与管理草稿，仍通过原 Settings 提交 Personal Overlay；公共 Map 编译、执行、Selection 和持久化边界不变。没有引入额外状态、订阅、重试或同步机制；React 修改仅过滤原事件入口。
- 验证边界：390px 是 Electron 布局模拟，不声称手机 shared-host / 真实 Web 上线验证。用例仍在 pending，不自动晋级。现有 fixture checker 不支持 settings spec 域，manifest 按已有格式补齐且实际用例通过，未扩修校验工具；原有验证债仍由 Todo102 承接，本轮未推进。
