# Todo143：模型配置勾选框颜色对齐系统组件

状态：已实现并完成本地验证／复审。2026-09-12 用户授权实现并提 MR。

## 要求与边界

- 输入类型、模型能力的勾选框沿用系统 Checkbox 颜色：选中使用 `border-primary bg-primary text-primary-foreground`；未选中使用 `border-input-border bg-input`。
- Zai 深色选中为白色框体／黑勾，浅色为黑色框体／白勾；不再让边框跟随对号的反色。
- 保留 16px 方框、12px Check 图形，以及外层选项按钮的底色反馈、个人覆盖边框、尺寸、点击与键盘语义。文本仍强制选中且不可取消。
- 指示框仍是不可交互的装饰元素；不在现有按钮中嵌套可交互 Checkbox，不修改全局组件或模型配置／保存逻辑。

## 验证与复审

- 先在真实组件浏览器夹具增加与系统 Checkbox 的 computed style 对照，覆盖中文浅色手机宽度、英文深色桌面宽度，选中／未选中及普通／个人覆盖选项。
- 保留点击、键盘单次切换、外层高亮和文本锁定断言；查看截图，运行相关单测、类型检查、lint、架构检查。
- Mac Electron／真实手机远控不为这次纯颜色修改重新全量运行；浏览器夹具不冒充原生整链验证。

根因：原 `border-current` 随 `text-primary-foreground` 变为勾号颜色，导致边框与填充反色。修复仅收口该指示框的语义颜色。

## 结果

- TDD：新增颜色断言在旧实现下两例均失败；修复后颜色／交互两例与 Todo141 编辑器四例合批 **6/6 通过**，相关单测 **51/51 通过**。
- `pnpm typecheck`（含桌面 E2E 类型）、`pnpm lint` 通过；lint 为既有 42 warnings、0 errors。架构检查 0 violations，`git diff --check` 通过。
- 已查看 `/tmp/zcode-provider-settings-batch/selected-{390,1200}-0.png`：深浅色框体／勾号符合系统组件。Linux 当前中文字库不完整，中文截图部分文字缺字，不声明字体视觉验收通过；不影响已执行的颜色、尺寸及交互断言。
- 复审：生产代码仅一个共享指示框的 class 分支变化；两个调用类别均覆盖，无新增状态、事件、IO、协议、持久化或模型能力变更。外层个人覆盖、文本锁定、按钮键盘语义和勾号图形未改，未嵌套可交互控件。
- 未重跑 Mac Electron／真实手机 shared-host；此项是共享 UI 颜色修复，不改变桌面 continuous／手机 replayable 链路。
