# Welcome Screen Provider Region Tags

Welcome Screen 的 OAuth provider 入口在未登录时同时展示 Z.AI 与 BigModel。为了帮助用户区分两个入口的服务区域，按钮文案后展示固定地域标签：

- Z.AI：中文 `全球`，英文 `Global`
- BigModel：中文 `中国`，英文 `CN`

标签文案必须走 `packages/ui/src/i18n/locales/*`，组件只保留 provider id 到 message id 的映射。标签只表达入口区域差异，不参与 OAuth provider 选择、排序、可用性或 provider family domain 判断。尺寸使用紧凑 pill：`h-5 px-2 text-ui-xs`。

OAuth provider 按钮使用 `Button variant="default"`，背景来自 `bg-primary`。ZAI 主题下浅色为 `#000000`、深色为 `#ffffff`，文字分别使用 `text-primary-foreground`。地域标签作为按钮内部附属信息，不再使用 Coding Plan 的独立渐变徽标；样式应跟随按钮前景色，使用 `border-primary-foreground/30 text-primary-foreground/60`，保证浅色和深色主题里都只是弱强调。
