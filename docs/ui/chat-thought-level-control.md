# Chat Thought Level Control

## 目标

聊天输入框工具栏的 thought level 控件需要直接展示当前思考阶梯文案，让用户不打开额外浮层也能知道当前档位。

## 当前实现

- `packages/ui/src/chat-input-toolbar/ThoughtLevelCycleControl.tsx`
  - 控件默认使用 select 菜单交互，点击后展开当前模型支持的 thought level 列表。
  - 旧版点击循环切换交互保留为 `interactionMode="cycle"` 参数，便于在需要更快切换的场景恢复。
  - 触发器显示脑图标、当前阶梯文案和竖向阶梯条；文案来自当前 `thought_level` option 的本地化展示名。
  - 当前阶梯文案切换时使用轻量纵向滚动动效；系统开启 reduced motion 时直接静态替换。
  - 桌面宽度展示当前阶梯文案；窄屏沿用工具栏的 `labelVisibilityClassName` 收起文字，保证手机 Web 不挤压输入框。
  - 竖向阶梯进度条只在 composer 的 `sm` 到 `xl` 区间显示：小于 `sm` 的超窄宽度隐藏进度条，仅保留脑图标；达到 `xl` 后进度条随当前阶梯文案出现而隐藏。
  - V4 composer 在小于 `xl` 的窄宽度隐藏下拉箭头，但保留脑图标和上述阶梯条响应规则；继续缩到 `sm` 以下时，trigger 收敛为正方形图标按钮。达到 `xl` 后恢复箭头。
  - tooltip 会根据当前阶梯文案是否显示在按钮里切换：文案可见时显示功能名，英文为 `Thought Level`、中文为“思考级别”；文案因输入框变窄被收起时，tooltip 标题改为当前阶梯文案。
  - 默认点击展开 select 菜单；恢复 `cycle` 模式后点击只循环切换阶梯，不主动弹出 tooltip。
  - `Ctrl+T` 始终保留快速切换语义，按当前展示顺序直接切到下一个 thought level，不打开 select 菜单。
  - `aria-label` 继续使用当前阶梯文案，方便读屏直接读出当前值。

## 档位文案与顺序（Todo153）

模型配置提供可选档位及其顺序。控件只做展示投影，不凭 value 或 name 重新排序；下拉菜单、点击循环和 `Ctrl+T` 使用同一配置顺序，末项循环到首项。配置按低到高声明 minimal 在 low 前、ultra 在 max 后；开启是开关语义，不固定插入高与极高之间。

| 原始 value                                                         | 中文 | 英文       |
| ------------------------------------------------------------------ | ---- | ---------- |
| disabled / false / no / none / nothink / no-think / no_think / off | 关闭 | Off        |
| enable / enabled / on / true                                       | 开启 | On         |
| minimal                                                            | 极低 | Minimal    |
| low                                                                | 低   | Low        |
| medium                                                             | 中   | Medium     |
| high                                                               | 高   | High       |
| xhigh / extra-high / extra_high                                    | 极高 | Extra high |
| max                                                                | 最高 | Max        |
| ultra                                                              | 极致 | Ultra      |

文案匹配对 value 去首尾空格并转小写；选中与提交保留原始 value，不合并同名选项。extra-high／extra_high 为保留别名，不额外扩充其他拼写。

light、shallow、balanced、default、normal、standard、deep、maximum、very-high、very_high 取消固定归类，和其他未知值一样显示来源提供的 name，仍可选择。不按 name 猜强度或是否关闭，不自动新增档位或改写配置。

阶梯条仅将关闭类 value 视为零强度；非关闭项按其在配置中非关闭项序列的位置递增。即使关闭项不在首位，也不扣减后方关闭项而误显示零进度。未选／失效值保持零进度与占位；单档有效选择只读。

验收覆盖中英文文案、未知名称回退、原值提交、自定义顺序、菜单／键盘／触控／循环一致、阶梯条以及空值／失效／单档边界。桌面与手机尺寸、深浅主题使用共用控件；自动任务、Subagent 复用相同规则。

## 兼容边界

- Todo153 调整 UI 展示并移除前端名称排序，保留来源顺序；不改变 currentValue 写入、workspace 默认思考等级、请求参数映射或 task realtime 链路。
- 桌面端和 Web 端共用同一 React 组件；手机端只受响应式文字显隐影响，不改变 remote replayable 语义。
- `Ctrl+T` 不依赖触发器 click，避免默认 select 交互覆盖快捷键快速切换。
