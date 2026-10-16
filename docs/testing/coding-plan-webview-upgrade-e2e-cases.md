# Coding Plan Webview Upgrade E2E Cases

本文记录 Coding Plan 升级入口迁到官网 embedded webview 后，桌面端需要覆盖的 E2E case。范围限定在 desktop local workspace，接口使用 WDIO case-local mock server，不访问真实 BigModel / Z.AI 套餐接口。

## 覆盖原则

- 每条 case 都必须有独立 setup、action、assert，不把“打开过 webview”视为购买完成覆盖。
- 打开升级页后断言 Windows/Linux 的最小化、最大化、关闭窗口按钮可见且命中区域不被覆盖；macOS 不显示这组自绘按钮。按钮命令与关闭网页的区别由 `overlayWindowControls.test.ts` 回归。
- 官网 webview 完成支付后，App 的业务语义是：先关闭升级 webview，再刷新当前 Coding Plan provider。
- Provider 刷新通过当前 ProviderSettingsService / Account 凭据边界，至少覆盖返回新 key 的复制请求和 `subscription/list` 权益校验；不能把 Account apiKey 写入 Personal Provider Config。
- 本组 case 不发送模型请求，不生成 DeepSeek provider replay fixture。
- CPUW-01 初始即有 Personal/Start 权益，须通过真实 Account 控制面解析：初始 customerInfo 提供组织/项目，受控 mock profile 保留查询 Start 的 JWT，不用旧 Personal apiKey 伪造账号连接。库存 loading/error 文案同时覆盖中英文启动语言。

## Accepted Cases

Todo103 重接说明：下表历史 `builtin:*` 落盘 apiKey/enabled 断言已由当前架构替代。CPUW-01 核对本次新 key 对应的 copy 请求、入口完整库存与 WebView 同一 funnel、刷新/重载不重复上报；CPUW-01/03 还断言 Account key 不泄漏到 Personal Config。账号密钥解析与实际凭据缓存归服务层测试，不为 E2E 恢复旧 Provider Store。候选 Electron 实跑结果另记 Todo103，不继承历史通过。

| Case    | 场景                                                                             | Setup                                                                                                                                                                                                   | Action                                                              | Assertions                                                                                                                                                                                                        |
| ------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CPUW-01 | 官网 webview 通知 App 关闭升级弹窗并刷新当前 provider                            | 已登录 BigModel，当前连接方式为 BigModel Coding Plan；初始 provider apiKey 为 `bigmodel-personal-api-key`；mock 官网页可触发 `window.zcodeBridge.notifyPurchaseComplete({ provider: "bigmodel" })`      | 头像菜单打开升级 webview，在 guest webContents 中触发购买完成       | App 中 `coding-plan-embedded-webview` 消失；mock server 收到 `getCustomerInfo`、`api_keys`、`copy`、`subscription/list`；落盘 `builtin:bigmodel-coding-plan.apiKey` 更新为 mock 返回的新 key；provider 仍 enabled |
| CPUW-02 | 官网 webview 外链/加载异常不回退旧内置购买面板                                   | mock 官网页加载失败或接口返回系统繁忙                                                                                                                                                                   | 打开升级入口                                                        | App 展示 webview shell 或 load-failure fallback；不渲染旧 `CodingPlanPurchasePanel` 个人套餐按钮                                                                                                                  |
| CPUW-03 | Z.ai 官网 webview 通知 App 关闭升级弹窗并刷新当前 provider 与 Team Plan products | 已登录 Z.ai，当前连接方式为 Z.ai Coding Plan；webview localStorage 注入 `oauth:zai:access_token` 与 `zcodejwttoken`；mock 官网页可触发 `window.zcodeBridge.notifyPurchaseComplete({ provider: "zai" })` | 头像菜单打开升级 webview，在 guest webContents 中触发 Z.ai 购买完成 | App 中 `coding-plan-embedded-webview` 消失；mock server 收到 Z.ai provider 刷新所需 `getCustomerInfo`，并收到 `/subscription/enterprise/v2/pricing`；落盘 `builtin:zai-coding-plan` 保持 enabled                  |

## Pruned Cases

| Decision | Pruned combinations                 | Reason                                                                                                        | Representative coverage                                                                                                                   |
| -------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| CPUW-P01 | Z.AI PayPal / Stripe 真支付完成     | 需要真实第三方支付授权，不能在桌面 CI 中稳定执行；App 侧完成语义由 Z.ai mock webview completion 覆盖          | CPUW-03 覆盖 Z.ai bridge + App close/refresh；支付方式内部保留单元/组件测试                                                               |
| CPUW-P02 | Mobile `/remote` webview completion | 手机远控不创建独立官网购买 webview；当前升级 webview 是桌面 renderer 本地弹层                                 | CPUW-01 保持 desktop local scope；远端 Environment 的 Provider Runtime 独立拥有配置与 Registry，不由本用例验证跨 Environment Provisioning |
| CPUW-P03 | 企业 Team Plan webview 完整购买     | 当前官网完成信号到 App 的关闭/刷新语义与个人套餐相同；企业产品刷新只需断言 `refreshTeamPlanProducts` 单元覆盖 | `modelProviderCodingPlan.test.ts` 覆盖 Team products refresh；CPUW-01 覆盖真实 webview IPC                                                |

## Fixture Contract

- WDIO mock server 负责：
  - `/coding-plan`：模拟官网 embedded 页面。
  - `/api/v2/releases/latest`
  - `/api/v1/client/configs`
  - `/api/biz/customer/getCustomerInfo`
  - `/api/biz/v1/organization/:organizationId/projects/:projectId/api_keys`
  - `/api/biz/v1/organization/:organizationId/projects/:projectId/api_keys/copy/:apiKey`
  - `/api/biz/subscription/list`
  - `/api/monitor/usage/quota/limit`
- mock server 提供 `/__e2e/coding-plan/requests` 供 spec 断言请求。
- `CPUW-01` / `CPUW-03` 使用 `fast-text` timing，不依赖真实流式模型请求。
- Coding Plan webview origin 是 Vite 构建期常量。定向运行和默认全量 glob 都必须在
  desktop build 前启动同一个 shard-owned mock origin；不能等到 worker `beforeSession`
  才注入 origin。
- 同一全量 shard 可能依次运行 sold-out、system-busy 和 refresh-provider。mock origin
  在 shard 生命周期内保持不变，每个 upgrade worker 在启动 Electron 前通过测试控制端点
  重置 `scenario`、购买状态与 request ledger；其它 worker 不得关闭 launcher-owned server。
