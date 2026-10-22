# Gen UI 统一样式

## 目标与边界

以 DESIGN.md 为目标规范，App 原生组件为尺寸和状态参照。仅修改 Gen UI 的
主题投影和 visualize 基础资源；不修改 App 原生组件或第三方 MCP App 标准投影。
既有片段类名继续可用，独立 HTML 导出与内联共用基础 CSS。

## 样式契约

- 正文、按钮、表单使用宿主正文档位；h1/h2/h3–h6 使用正文 +4/+2/+0；
  辅助文字 -2，tooltip -1，行内代码 -2。图表作者标签可保留内容可读性下限。
- 圆角使用独立 sm/md/lg/xl token（默认 4/6/8/12px），不按比例推导。
  card/widget 从 xl 开始，嵌套逐级 lg/md/sm；普通 wrapper 不增加层级。
  控件在 xl 或无圆角父容器中用 lg，在 lg 中用 md，在 md/sm 中用 sm。
- card 使用 card/card-border；控件 primary 使用 App primary，链接和图表 accent
  独立保留品牌色。普通按钮选中使用 selected 表面，不改成品牌色。
- btn 默认为 outline；primary/secondary/ghost 分别使用对应语义颜色。
  默认最小高 28px，xs/sm/lg 最小高为 20/24/32px；disabled opacity 为 0.5。
  尺寸变体使用紧凑行高 1，高度允许随字号及内容增长；文字边界必须留在按钮
  内部，不能以固定高度裁掉放大后的文字。回归覆盖 14/18px 字号、相邻按钮
  边界及可见焦点轮廓。
- 普通 input/select 高 36px；紧凑 sm/xs 为 28/24px。使用 input 背景、
  input-border/hover/focused 和 focused 背景，placeholder 使用三级前景。
  Textarea 最小 64px、padding 8px，保留原生垂直调整能力。
- Checkbox 16px、支持 checked/indeterminate；Switch 32×18px、thumb 16px。
  半选 hover 保持 primary 背景和对比标记，不套用未选中 hover。
  独立导出缺少宿主 focused token 时使用 ring 边框，保证焦点区别于 hover。
  Range 保留现有原生行为和几何，统一颜色及 disabled；不引入新的 Slider 实现。
- 保留键盘可见焦点、原生 select 展开行为、coarse-pointer 的 44px 目标和
  editable field 最小 16px 防缩放规则。菜单完全同构不在本次范围。

## 唯一来源与主题同步

```text
App styles.css → Gen UI 专用变量映射 → 既有 HostContext → guest 根 CSS 变量
                                                   ↓
                                      visualize.css → 作者 HTML 控件
独立导出：同一 visualize.css → light/dark 默认值
```

字号/圆角使用 MCP 标准变量；专用颜色使用 `zcode/genUiStyles` HostContext 扩展，
由 shared schema 验证为 Gen UI CSS 变量键和字符串值。SDK 的标准变量对象为严格
枚举，不允许向其中塞入自定义键。新增变量仅位于 Gen UI 投影。主题/字体切换复用现有
根属性观察和 HostContext 路径，不增加缓存、timer 或状态来源。不修改尺寸协议、
沙箱注册、workspace identity、desktop continuous 或手机 replayable 链路；
手机当前无 Gen UI sandbox 时保留不支持状态，窄屏与触摸规则在内容层继续有效。

## 验证

### 展开预览的圆角裁切

加载态显示旋转 loading 图标和“正在加载…”（英文 Loading…），文字使用
text-ui-base，图标对辅助技术隐藏。离线、错误等状态不显示加载图标。
展开工具栏左侧显示现有 DialogTitle，有内容标题时显示，缺省标题仅供无障碍
使用，不显示“交互视图”。标题单行省略并提供完整 title，保留 Dialog 的 aria-labelledby
关联；右侧操作按钮保持可达，不修改 App 原生组件或内联工具栏。

展开内容使用 top-layer popover，外层 Dialog 的 overflow-hidden 无法裁切它。
Gen UI 预览锚点必须继承 Dialog 的左右下圆角，由既有承载层同步圆角并自行
overflow-hidden；顶部与工具栏相接，保持直角。Tweak 面板显示时，内容底部
与面板相接，也保持直角。关闭面板恢复底部圆角，不重建 webview。
回归在真实 Electron 中检查承载层的四角、裁切及面板开关后的实例保留。
App 原生 Dialog 和共享承载层行为不变。

- 映射单测：专用控件 token、完整字号/圆角、字体变化、缺项 fallback；标准 MCP
  投影保持不变。
- 真实 Electron 回归：深浅主题、390/1100px、字体变更后的 computed style；
  嵌套 wrapper 不改变圆角层级；按钮变体、input focus/hover/disabled、checkbox
  checked/indeterminate、switch、原生 select 与 textarea；独立导出默认样式。
- 既有 Gen UI E2E 检查放大/收起、复制、交互状态、测高和滚动仍成立。
- architecture、typecheck、lint、资源 hash 一致性与 focused unit tests。

macOS 为本次运行环境，Windows/Linux 的原生 select 菜单外观仍由系统决定，
需在对应平台补充视觉验收。

## 本次验证证据

主题/协议/装配/资源单测共 16 条；独立导出 vendor 测试 3 条。真实 Electron
回归覆盖上述主题、字号、宽度及控件状态；焦点样式通过活动 iframe 的 CDP
强制伪类验证，触摸样式通过独立导出 iframe 的触摸模拟验证，不等于真机验收。
现有放大、复制、测高、状态保留和离线导出回归沿用同一测试运行。
不包含 Windows/Linux 实机、手机 Web Gen UI 支持或登录账户生产验证。
