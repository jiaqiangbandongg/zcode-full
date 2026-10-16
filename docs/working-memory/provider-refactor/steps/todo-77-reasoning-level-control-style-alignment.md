# Todo 77：推理档位控件样式统一

> 验证归属更新（2026-09-09）：本文残余欠测/失败/人工晋级统一转交 [Todo102](todo-102-verification-debt-closeout.md)，关闭在本文中的独立验证排期；历史证据保留，转交不代表测试通过。

> 后续 Desktop 图形 E2E 欠测统一由 Todo 78 收口，本 Todo 不再单独排期。

> 2026-09-07 裁决补正：下文“不新增外部 Reasoning 容器”不代表最新产品要求。此前已确定新增“推理设置”和“高级设置”两个带标题容器，遗漏修复由 Todo 88 / R13 执行；本 Todo 的控件尺寸和居中要求仍有效。

> 状态：已完成（UI 单测、类型检查与 lint 通过；桌面图形 E2E 待 Mac 环境复跑）
>
> 日期：2026-09-04
>
> 关系：Todo 75 模型设置页 UI polish 的小范围视觉收尾。

## 问题

模型能力选项使用共享 `Button` 的 `outline + lg` 样式；推理档位则由自定义 `div` 和原生 `button` 组成。目前两者的高度、圆角、背景和文字对齐规则不同：

```text
模型能力选项：h-8 / rounded-lg / 共享 Outline / 居中布局
推理档位：    h-7 / rounded-md / bg-surface / 原生按钮默认排版
```

这不是外部容器造成的。推理档位自身没有复用共享按钮的尺寸和对齐规则，因此在同一个模型编辑弹窗中显得更小、颜色不同，非编辑态文字也缺少明确的水平和垂直居中。

## 目标

- 推理档位与模型能力选项使用一致的高度、圆角、默认边框和背景层级；
- 非编辑态档位文字显式水平、垂直居中；
- 编辑态、静态态和新增按钮切换时不发生高度跳动；
- 保留推理档位的拖拽、点击编辑、删除、键盘操作、顺序和 Personal Override 边框语义；
- 不把推理档位改成 checkbox，不改变 Reasoning 值、Mapping、保存和运行时行为。

## 实施边界

1. 优先复用共享 `Button` 的尺寸与颜色规则，避免在 Reasoning Editor 中复制第二套按钮体系。
2. 推理档位仍允许在同一外壳内显示 Hover 删除按钮；若无法直接使用完整 `Button`，只抽取或复用必要的 `buttonVariants`，不改变 DOM 交互职责。
3. 静态文字按钮使用 `inline-flex items-center justify-center`；编辑输入保持同高，并按内容在既有最小／最大宽度内伸缩。
4. 新增按钮与档位外壳同高；Focus、Hover、拖拽和 disabled 状态继续使用设计系统语义色。
5. 不新增外部 Reasoning 容器，不调整 Mapping、MFJS 或 Footer 布局。

## 验证

- 先补或更新 `ProviderModelReasoningLevelEditor` 单测，覆盖静态居中、统一尺寸、编辑态尺寸和删除按钮交互。
- 更新模型设置 UI E2E，只验证可见结构、实际尺寸一致和编辑／拖拽行为，不绑定无必要的内部 class 名。
- 验证中文／英文、深色／浅色以及窄窗口布局。
- 执行相关 UI 单测、`pnpm typecheck`、`pnpm lint`；桌面图形 E2E 在 Mac 环境补跑。
