# ZCODE_ENV 环境收敛

## 背景

历史上桌面端同时使用 `ZCODE_ENV`、`ZCODE_API_ENV` 和
`ZCODE_DESKTOP_BUILD_ENV*` 表达构建形态、API 环境和发布产物环境，容易让测试
产物误带开发行为，也让 CI 默认值难以判断。

## 目标

`ZCODE_ENV` 是唯一产品环境变量，枚举只保留：

- `test`：测试环境，使用测试 API / OAuth endpoint，允许展示测试专用菜单。
- `production`：正式环境，使用正式 API / OAuth endpoint，隐藏测试专用菜单。

本地开发不是产品环境。未显式设置 `ZCODE_ENV` 时默认按 `test` 运行；本地调试能力
由运行形态判断，例如 Electron 是否 packaged、Vite dev mode 或专用 debug 开关。

## 配置规则

`.env*` 文件只保存链接和公开 OAuth client id 等配置，不保存当前产品环境选择。
链接配置按环境前缀分组，避免 host、Vite 和业务代码重复声明同一 URL：

- `ZCODE_TEST_BASE_URL`
- `ZCODE_PRODUCTION_BASE_URL`
- `ZAI_TEST_OAUTH_ORIGIN`
- `ZAI_PRODUCTION_OAUTH_ORIGIN`
- `ZAI_TEST_BUSINESS_BASE_URL`
- `ZAI_PRODUCTION_BUSINESS_BASE_URL`
- `ZAI_TEST_OAUTH_CLIENT_ID`
- `ZAI_PRODUCTION_OAUTH_CLIENT_ID`

构建配置根据 `ZCODE_ENV` 选择对应链接，并向 renderer 注入公开的 `VITE_*` 值。
renderer、host/service 和 agent 里的 ZCode API、远控链接、zcode-plan OpenAI/Anthropic
入口都通过 `@zcode/shared` 的 endpoint resolver 派生，业务代码不要再手写
`zcode.z.ai` / `zcode.z.ai` 的 zcode-plan URL。

## Endpoint resolver

`packages/shared/src/zcodeEndpoint.ts` 是产品环境域名的唯一事实源。运行时调用方必须把
当前 `env` 显式传入 resolver，不能在 service/provider 内部读取编译期全局 `ZCODE_ENV`。

默认域名矩阵：

| 产品环境 | ZCode API | ZAI OAuth | ZAI Business API | BigModel API |
| --- | --- | --- | --- | --- |
| `test` | `https://zcode.z.ai` | `https://chat.z.ai` | `https://api.z.ai` | `https://bigmodel.cn` |
| `production` | `https://zcode.z.ai` | `https://chat.z.ai` | `https://api.z.ai` | `https://bigmodel.cn` |

覆盖优先级：

1. 完整 URL 覆盖优先，例如 `ZAI_OAUTH_AUTHORIZE_URL`、`BIGMODEL_OAUTH_AUTHORIZE_URL`。
2. 不带环境前缀的 origin/base 覆盖其次，例如 `ZCODE_BASE_URL`、`ZAI_OAUTH_ORIGIN`、`ZAI_BUSINESS_BASE_URL`、`BIGMODEL_API_BASE_URL`。
3. 环境 scoped 覆盖再次，例如 `ZCODE_TEST_BASE_URL`、`ZAI_PRODUCTION_OAUTH_ORIGIN`、`BIGMODEL_TEST_API_BASE_URL`。
4. 最后使用 shared resolver 内置默认域名。

`.env.development` 只保存本地开发常用的测试环境链接常量；它本身不选择产品环境。
桌面启动脚本按所选命令显式注入 `ZCODE_ENV`；默认 `pnpm dev:desktop` 当前指向正式环境，
测试环境必须显式使用 `pnpm dev:desktop:test`。

## 启动与 CI

- `pnpm dev:desktop` 默认等同于 `pnpm dev:desktop:prod`。
- `pnpm dev:desktop:test` 显式注入 `ZCODE_ENV=test`。
- `pnpm dev:desktop:prod` 显式注入 `ZCODE_ENV=production`。
- CI 未传 `ZCODE_ENV` 时默认 `production`。
- CI 只接受 `ZCODE_ENV=test|production`，不再读取
  `ZCODE_DESKTOP_BUILD_ENV*` 或 `ZCODE_API_ENV`。
- `ZCODE_ENV=test` 只允许构建、收集、上传测试产物；`publish-release.sh`
  会拒绝测试环境调用正式 release API。

## 安装包命名

正式环境安装包保持原有文件名，例如 `ZCode-3.0.0-mac-x64.dmg`。
测试环境安装包在架构后追加 `_TEST`，例如 `ZCode-3.0.0-mac-x64_TEST.dmg`。
同一规则适用于 macOS、Windows、Linux 产物，避免测试包与正式包在下载、上传或人工验收时混淆。
构建产物飞书通知会显示“测试环境/正式环境”标识；release 发布通知只用于正式发布。
