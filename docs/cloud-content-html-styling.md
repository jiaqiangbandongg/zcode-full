# 公共内容描述 HTML 样式

2026-09-11。仅扩展 `description.format=html` 的 HTML 属性，不改变接口结构、外层 description.style、Hero ZIP、轮询或上报。

```text
服务端 content -> inert template -> 标签过滤 / class 合并 / style 校验 -> React 节点
```

唯一渲染入口为 CloudDialogDescription，无新增异步状态；桌面/Web共用，不修改 continuous/replayable 通信。

## class

不设运行时白名单，保留未知类名；服务端约定使用 Tailwind。使用现有 cn(标签默认类, 云端类) 合并冲突。仅 App 已打包 CSS 生效，不运行动态编译器，不加载远端 CSS。styles.css 的 @source inline 仅保证当前模板常用工具类稳定打包，不用于过滤下发类。

class 可以使用已打包的布局/定位类，因此此能力仅面向可信服务端维护的内容，不声称 HTML 样式被安全隔离。重要性与选择器优先级仍遵循 CSS。

## inline style

在未挂载元素上通过 CSSStyleDeclaration 解析完整声明，再按属性和值筛选，生成 React CSSProperties；非法声明单独丢弃。禁止任意变量定义、资源 URL、转义值、!important、定位/尺寸/层级/变换/动画。

| 属性 | 接受值 |
| --- | --- |
| color / background-color / text-decoration-color | 浏览器认可的颜色、currentColor；精确 var(--color-foreground)、foreground-subtle、foreground-subtlest、foreground-inverse、primary、primary-foreground、secondary、brand、icon-blue、success、warning、destructive、popover、surface、background 对应 token，无 fallback |
| font-size | 精确 var(--text-ui-xl/lg/base/caption/sm/xs)；不开放任意字号 |
| font-weight / font-style | 1..1000、normal/bold/bolder/lighter；normal/italic/oblique |
| line-height | normal 或 1..3 的无单位数值 |
| text-align | start/end/left/right/center/justify |
| white-space | normal/nowrap/pre/pre-wrap/pre-line/break-spaces |
| overflow-wrap / word-break | normal/break-word/anywhere；normal/break-all/keep-all/break-word |
| text-decoration / text-decoration-line / text-decoration-style | none/underline/overline/line-through 与 solid/double/dotted/dashed/wavy 合法组合；颜色和厚度使用独立属性 |
| text-decoration-thickness / text-underline-offset / letter-spacing | 0..32px、0..2rem/em 或单位零；另接受 auto/from-font 或 normal（按属性） |
| margin / padding 及 top/right/bottom/left | 1..4 个非负有限长度，单值 0..32px 或 0..2rem/em，拒绝百分比、auto、calc |

默认标签样式沿用旧实现，允许的 inline style 按正常 CSS 优先级覆盖类。安全标签、链接宿主回调、20,000字符/32层超限纯文本回退保持不变；plain_text/markdown 不解释 HTML。

## 验收

先测试后实现：用户完整 class 示例、未知类保留、class 与默认样式冲突、inline style 优先级、安全值拒绝、事件/标签/链接回归、无 callback 链接样式、旧内容回归。App E2E 通过隔离 HTTP 下发 HTML，验证真实计算样式和关闭上报不变；窄屏与明暗主题检查不等同于手机/各系统实机。

验证记录：4文件50项单测通过；macOS 隔离 App E2E 13项通过，run `desktop-e2e-20260911073714355-p21756-b72a79ab40f8cbad`。新增用例验证云端 class 日期的600字重/虚线下划线/不换行、inline style 覆盖、未知类保留、危险定位删除、明暗主题颜色、358px 内容宽度收敛后无横向溢出及仅关闭时 cancel。已检查运行截图。typecheck、E2E typecheck、架构检查通过；lint 0错误/46条既有警告。未执行 Windows/Linux/手机实机、真实服务端投放或全量 Web 构建；不宣称任意 Tailwind 类可动态生成。
