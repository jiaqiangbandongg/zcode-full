# Todo 75：模型设置页 UI polish 合入与当前架构适配

> 验证归属更新（2026-09-09）：本文残余欠测/失败/人工晋级统一转交 [Todo102](todo-102-verification-debt-closeout.md)，关闭在本文中的独立验证排期；历史证据保留，转交不代表测试通过。

> 后续 Desktop 图形 E2E 欠测统一由 Todo 78 收口，本 Todo 不再单独排期。

> 2026-09-07 裁决补正：下文“不再有高级设置分组”仅记录当时合入结果，已被后续用户裁决取代。应增加“推理设置”（档位 + Mapping）和“高级设置”（MFJS）两个带标题容器，不折叠；遗漏修复由 Todo 88 / R13 执行。

> 状态：已完成（代码与本地验证完成；桌面图形 E2E 待 Mac 环境）
>
> 日期：2026-09-04
>
> 来源：`fix/model-settings-ui-polish`

## 目标

将设计师分支中与模型设置页相关的 UI 改进合入当前 m2，并在当前 Provider 重构代码上完成必要整理。只调整展示、布局、交互和对应测试，不改变 Provider、Registry、Overlay、模型选择持久化或请求运行时语义。

## 保留的改动

- 模型编辑弹窗的字段布局、模型 ID 与启用开关的排列；
- 输入模态和模型能力的图标化选项；
- Reasoning 档位编辑器的尺寸与新增入口；
- 模型列表内边距、拖拽时的分隔线和添加模型按钮；
- 设置页头部操作按钮与 Provider 保存反馈样式；
- 设计师分支新增的模型设置 UI 单测和 E2E 覆盖。

## 合入后的整理

- 当前产品没有“高级设置”这一层，移除相关折叠、分组和文档表述；
- Reasoning 档位按设计师方案使用普通 UI 字体；
- E2E 保留结构和行为验证，减少对具体 CSS class、像素间距和内部实现的绑定；
- 确认窄窗口下模型 ID 输入框和启用开关均可正常使用，不新增额外响应式语义；
- 保留 Audio/PDF 等底层兼容数据，不因 UI 收窄而静默删除。

## 执行与验收

1. 合入 `origin/fix/model-settings-ui-polish`，记录合并结果。
2. 在当前 m2 代码上完成上述整理，检查 Provider 抽象和保存链路未被改变。
3. 运行模型设置相关单测、E2E、`pnpm typecheck` 和 `pnpm lint`。
4. 全面 review 变更范围，确认桌面/Web、中英文、深浅主题没有明显回归。
5. 通过验证后提交并推送当前 m2 分支。

## 实施结果

- 已合入 `origin/fix/model-settings-ui-polish`，保留设计师分支的 UI 改动和测试覆盖。
- 已移除“高级设置”这一不存在的产品层级；Reasoning、Mapping 和 MFJS Tool Schema 直接作为普通模型配置展示。
- 已同步实现、E2E 和设计文档，未改动 Provider、Registry、Overlay、模型选择持久化或请求运行时语义。
- 已通过模型设置相关 7 个 UI 测试文件、74 个测试，`pnpm typecheck`、`pnpm lint` 以及 push 前受影响测试；当前环境未执行桌面图形 E2E，需在 Mac 上按既有流程补跑。
- 合并提交：`700b5ba77c`、`d10f45c65f`；已推送至 `provider-refactor-m2`。
