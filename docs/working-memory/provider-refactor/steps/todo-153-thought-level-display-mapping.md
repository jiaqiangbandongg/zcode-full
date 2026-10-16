# Todo153：思考档位展示映射与配置顺序对齐

> 状态：已实现并完成本地单测、浏览器交互与视觉验证；未推送。完整原生／手机远控链路未重跑。
> 日期：2026-09-16。
> 2026-09-16 用户授权实施：修改共享 UI 控件及中英文文案；模型配置和请求参数保持原样。

## 目标与范围

统一思考档位的中英文文案，区分 minimal 与 low，补齐 ultra，移除缺少明确契约的前端强制归类。菜单与循环切换尊重模型配置声明的顺序，不再凭名称猜测强度。

关联：[思考档位控件 spec](../../../ui/chat-thought-level-control.md)、[Todo66 选项展示格式](./todo-66-option-map-variable-naming-and-display-formatting.md)、[Todo138 通用推理兜底](./todo-138-reasoning-level-ui-and-api-defaults.md)。本条覆盖旧展示映射与前端排序约定；不重开 Model Config、默认选择及请求映射裁决。

## 已确认展示映射

| 原始值                                                                      | 中文 | 英文       |
| --------------------------------------------------------------------------- | ---- | ---------- |
| `disabled`、`false`、`no`、`none`、`nothink`、`no-think`、`no_think`、`off` | 关闭 | Off        |
| `enable`、`enabled`、`on`、`true`                                           | 开启 | On         |
| `minimal`                                                                   | 极低 | Minimal    |
| `low`                                                                       | 低   | Low        |
| `medium`                                                                    | 中   | Medium     |
| `high`                                                                      | 高   | High       |
| `xhigh`、`extra-high`、`extra_high`                                         | 极高 | Extra high |
| `max`                                                                       | 最高 | Max        |
| `ultra`                                                                     | 极致 | Ultra      |

- “不思考 / No thinking”统一并入“关闭 / Off”；只统一文案，不合并、删除或改写原始选项值。
- minimal 独立展示为“极低 / Minimal”，不再和 low 同名。
- `extra-high`、`extra_high` 原已存在，最终决定保留；本条不新增其他拼写别名。
- 匹配文案时保留现有去首尾空格、转小写行为；选中、保存及提交仍使用原始 value。
- ultra 仅补展示支持，不自动给模型增加此档位，不假设所有接口都接受原始 `ultra`。

## 取消固定归类与未知值回退

取消以下值在前端的固定文案映射与名称推断排序：

`light`、`shallow`、`balanced`、`default`、`normal`、`standard`、`deep`、`maximum`、`very-high`、`very_high`。

这些值仍可作为合法的自定义档位存在；显示来源提供的 `entry.name`，保留现有通用回退路径。未知值按相同方式处理，不过滤选项，不将其替换为最接近的已知档位。特别是 default 不再被解释成 medium。

## 顺序与交互边界

- 模型配置中的档位数组是顺序来源；前端保持收到的选项顺序，不另建名称 rank 表，不根据 `entry.name` 猜等级。
- 配置应从低到高声明：关闭、极低、低、中、高、极高、最高、极致；即 minimal 在 low 前、ultra 在 max 后。该约定不是前端重排算法，也不在本条批量重写现有配置。
- “开启”属于开关语义；两档模型按配置显示“关闭 → 开启”，不再固定插入“高”和“极高”之间。
- 下拉菜单、按钮循环及 `Ctrl+T` 使用同一来源顺序，到末尾后回到首项；不因展示名变化修改当前选择。
- 阶梯条按实际选项顺序表达相对位置；关闭类为零强度。保留未选／失效值的占位与零进度、单档有效选择只读、非法值不可提交等既有规则。
- 桌面与手机共用展示契约，中英文、深浅主题、键盘及触控均需验证；复用组件的其他页面同步生效。

## 调研依据与兼容边界

2026-09-16 核对了内置配置之外的 CLI、协议投影、历史迁移、测试和外部文档。不能用“内置配置没有出现”推导“外部无人使用”。

- `extra-high`、`extra_high` 是外部工具与用户配置中已有的 xhigh 别名写法，因此保留这两项；default 用于恢复默认，不能固定解释为中档。
- Balanced、Deep 等展示名在外部工具中常见，实际值通常为 medium、high；这只说明词汇存在，不能建立所有来源通用的 value 等价契约。
- 本项目 `packages/shared/src/model-config.ts` 接受非空、非重复的任意字符串档位（即用户自定义名称），不能通过缩小展示表限制配置值域。
- 外部工具中的 ultra 还可能包含运行时编排语义。此处“极致 / Ultra”是展示裁决，不将外部运行策略导入 ZCode，也不改变请求层 `reasoningLevel.map`。
- 其余取消映射的词，本轮未找到足以支撑全局强制归类的依据；不声称这些词从未被使用。

保留已保存选择、原始 value、合法性校验、Provider／模型身份、默认选档策略与请求参数映射。不增加 schema、迁移、builtin revision、运行时状态或跨端同步机制。

## 实施入口与验收

主要入口：`packages/ui/src/chat-input-toolbar/thoughtLevelOptions.ts`、`ThoughtLevelCycleControl.tsx`、中英文 locale；检查 V4 composer 和其他复用控件的页面。配置投影见 `packages/ui/src/lib/modelThoughtOption.ts`、`zcodeSessionProjection.ts`。

- [x] 先更新现有思考档位控件 spec，核对会话、定时／闲时任务、Subagent、Repo Wiki 的共享控件调用方；新增 TL-01/02 验收条目。
- [x] 先补预期测试，再改实现：中英文逐项核对最终映射；minimal 与 low 同时出现时文案不同；ultra 正确显示；所有关闭别名统一为 Off／关闭。
- [x] 验证 extra-high／extra_high 保留；取消映射的十个值和其他未知值显示来源名称，仍可选择，提交原始 value。
- [x] 用显式自定义顺序验证菜单和循环切换不再重排；覆盖 minimal／low、max／ultra、关闭／开启及循环回首。
- [x] 覆盖阶梯条、空值／失效值、单档只读、同值确认等现有边界；文案归一不改变当前选择或去重选项。
- [x] 真实共享控件及 Subagent 字段的浏览器交互覆盖桌面／触控手机尺寸、中英文与深浅主题；自动任务等调用方定向单测通过。完整原生及手机远控链路未重跑，浏览器候选保留 pending，不自动转正。
- [x] typecheck、lint、架构检查和受影响测试通过，完成 diff review；验证范围与环境限制见下方。

## 本轮交付

- 2026-09-16：仅新增本 Todo 与实施索引；产品实现和以上验收尚未执行。
- 2026-09-16 后续实施：删除前端名称 rank／排序函数；统一关闭文案，补 minimal／ultra，保留两种 extra-high 别名；未知值回退来源名称。关闭判断只读取原始 value，阶梯条按非关闭项在来源数组中的位置计算，避免关闭项居中时进度错误。未知字符串还覆盖 constructor／**proto**，不误命中映射表原型属性。

## 验证记录

- 修改前定向测试 45 项失败，浏览器实跑复现 `minimal` 显示 Low 而非 Minimal；修改后档位／控件／同值确认三文件 102 项通过，六个调用方测试文件 90 项通过，共 192 项。
- `node --test packages/ui/test/browser/manual-review/pending/thought-level-display.test.mjs`：八组通过（390／1200 × 中英 × Zai Light／Dark），覆盖真实菜单、触控、键盘选择、生产快捷键 hook、点击循环及 Subagent 字段。截图与日志在临时 artifact 目录 `todo153-thought-level-display`，保留菜单和选择后画面。
- 当前 Linux 使用已有隔离库和中文字体，通过 `LD_LIBRARY_PATH`、`FONTCONFIG_FILE` 提供，不修改产品运行环境。首轮中文 fixture 误用 locale prop、键盘早于 Radix 聚焦的验证问题已修正；截图等待入场动画结束后重取，中文字体和四类尺寸／主题代表图已目视检查。
- `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过；lint 47 条既有警告、0 错误。格式、链接和 diff 检查通过。
- 未运行完整 Electron、手机远控重连或真实供应商请求；本次没有改动这些链路。浏览器 evidence 不冒充上述验证或正式桌面 E2E 准入。
