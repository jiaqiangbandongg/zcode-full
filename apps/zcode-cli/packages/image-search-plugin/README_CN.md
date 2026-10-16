# ZCode 搜图插件

[English](./README.md)

本插件注册 ZCode 官方搜图 MCP 服务，让 Agent 在制作文档、演示文稿、海报或网页时可以检索插图与参考配图。

## 包含组件

- MCP 服务 `image_search`（HTTP），命名空间为 `plugin:image-search:image_search`。

## 使用前提

- ZCode 会话已登录且可访问 `${ZCODE_BASE_URL}`；该服务使用 ZCode 官方 JWT 鉴权，无需手动配置 Token 或 API Key。
- 可访问 ZCode API 的网络环境。
- 安装或更新插件后需新建 ZCode 会话。

## 使用方式

安装后用自然语言提出配图需求即可，例如「给封面找一张风力发电场的照片」，Agent 会调用搜图工具。
`documents`、`pdf`、`presentations` 等插件已不再内置该 MCP 服务，需要在文档制作过程中使用搜图时，
请与它们一并安装本插件。

## 说明

- 本插件仅声明 MCP 服务，不包含命令、技能、Hooks 或 Agent。
- 搜索结果经 ZCode 服务来自第三方图库，用于对外交付前请自行确认图片授权。
