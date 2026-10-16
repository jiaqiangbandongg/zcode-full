# Weekend Banner 资源包

## 2026-09-12 制作工作区迁移

Banner / Hero 源码、模板、数据样例及打包工具已迁到独立本地工作区
`/Users/dev/Projects/zcode-marketing-resources`（不建立 Git），本 App 仓库不再维护资源制作目录。
当前入口为该工作区 README.md，资源分别在 packages/weekend-banner、packages/weekend-hero，
产物在 dist/<包名>/<版本>/。运行 `npm test`、`npm run check`、`npm run test:browser`、`npm run build`。
原有完整目录和旧协议草稿保留在该工作区 archive/app-cleanup-20260912-qJ2R6s；
已经删除的两个受 Git 跟踪的旧 ZIP 另从清理前 HEAD 保存到归档的 tracked-baseline/。
仅清理制作资源，不改变 App 协议、资源下载/缓存、界面、轮询、上报或测试 fixture。
以下为历史视觉约定，包版本号不再代表新工作区构建版本；发布必须使用新产物 metadata.json 的摘要。

Banner 资源包不再绘制“领取 / Claim”按钮或消费 ctaZh/ctaEn，模型说明使用释放后的宽度。整块 Banner 的点击与右上角关闭仍由 App 负责，包不增加事件处理。新包输出为 weekend-banner-v3.zip，保留现有 v2 文件。

Hero v4 重播按钮尺寸与 App 关闭按钮一致：24×24px，图标 12×12px；鼠标 hover 不显示描边。默认透明背景、白色 70% 图标与原 hover 浅白底保持不变，键盘 focus-visible 保留独立焦点提示。仅修改 Hero 包，不改变 Banner、App 关闭按钮或重播行为。

## 2026-09-11 额度规则更新

Hero v4 与 Banner 共用包内 quota.js，直接读取 init.data.zcode_plan.entitlements。
仅 model_usage 且 period=one_time/daily 的非负有限 grant_units 参与计算。
存在一次性权益时只合计一次性，否则合计每日权益，并显示 Tokens / 天或 Tokens / day。
未知周期不参与，空权益为 0；没有 zcode_plan 时保留旧显式文案数据兼容。
模型说明/权益列表仅展示本次选中的周期，避免日额度混入一次性展示。
Banner 保持 18px 数值字号，完整千分位数字，不使用紧凑单位、不截断数字、不缩放。
不改变 App 领取、上报或实际额度。
Hero 源码现位于独立工作区 packages/weekend-hero；历史资源目录已归档，发布必须上传新 ZIP 并更新 URL/SHA。
Hero 权益明细行的单项额度按语言缩写（10亿 / 1B），顶部合计与 Banner 数值保持完整数字。

来源：Find lower-left banner 任务最终可编辑模板（活动名 12px）。
产物：独立工作区 `dist/weekend-banner/<版本>/` 下的 ZIP，入口 `index.html`。

包保留品牌 SVG、蓝色光晕、额度和模型说明；不是图片合集，也不携带模板编辑器。
外框高度 96px、边框与圆角由 App 提供，包自适应 94px 内容区与可变宽度。
包不绘制关闭按钮，不执行点击动作或上报；App 的 close 动作负责关闭。
保持静态视觉，无外部依赖、存储、网络请求或自主动画。

```text
下载 ZIP / 校验 SHA → App 解包 → sandbox iframe
  → init(theme,locale,data,instanceId) → 绘制 → ready
  → theme / resize → 重绘
  → destroy → 清理
```

沿用 `zcode-cloud-hero-v1`。visibility/reducedMotion 无动画可暂停，保持静态。
仅接受 parent 消息及当前 instanceId；所有可配置文字转义后绘制。
args 支持 titleZh/titleEn、amountZh/amountEn、modelsZh/modelsEn、unit；旧 cta 字段忽略。
未配置时使用原模板示例（100亿 / 10B）；这些是展示样例，不是用户实时权益。
`args.zcode_plan.entitlements` 自动适配 model_usage 权益：一次性优先、同周期累加，
完整千分位显示总额，show_name 生成所选周期的模型说明。
已有 plan 但无有效权益显示 0，不回退示例额度。显式 amountZh/amountEn、modelsZh/modelsEn
优先于 plan；没有 plan 时也支持 App 的 amountValue/amountUnit 字段。
当前文案较长时沿用原模板省略号；右上角为 App 关闭按钮预留空间。

验证：在独立工作区运行 `npm run test:browser`，覆盖隔离 iframe ready、
中英文×亮暗主题、数据转义、可变宽度、清理和页面错误；不调用真实领取接口。
交付数据 CDN URL 为占位，上传后必须替换；不自动修改线上投放。
