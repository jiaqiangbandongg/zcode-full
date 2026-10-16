# Coding Plan Provider 可用性语义

Coding Plan provider 的模型菜单可见性由 `model-providers.json` 内的 provider 状态收敛：

- `apiKey` 表示本地已有凭据，不代表一定具备 Coding Plan 权益。
- `enabled` 表示 provider 当前是否允许进入 Agent registry 和模型菜单。
- `systemDisabledReason` 表示系统自动关闭原因；`enabled=false` 且该字段为空时表示用户手动关闭。
- Z.AI / BigModel Coding Plan 的可用性只校验 provider apiKey 是否能成功访问 `/api/biz/subscription/list`。
- 是否已有 Coding Plan 套餐不再用于系统禁用 provider；无套餐、非 Coding Plan 套餐、套餐过期等状态由详情页套餐列表和升级入口处理。
- Z.AI Start Plan 仍单独校验 `/api/v1/zcode-plan/billing/balance?app_version=<ZCODE_VERSION>` 返回的 `data.plans` 是否存在 active Start Plan。
- BigModel Start Plan 登录后使用已落盘的 ZCode JWT 校验 `/api/v1/zcode-plan/billing/balance?app_version=<ZCODE_VERSION>`；只要 JWT 鉴权成功即启用入口。用户仍可在设置页手动禁用。

## 系统关闭原因

- `coding_plan_not_authenticated`：Z.AI / BigModel Start Plan 未登录或缺少登录凭据。
- `coding_plan_not_connected`：BigModel Coding Plan 未连接或缺少授权凭据。
- `coding_plan_auth_failed`：已有凭据但鉴权失败。
- `coding_plan_not_entitled`：Z.AI Start Plan 凭据有效但没有 active Start Plan；Z.AI / BigModel Coding Plan 不再因为无套餐权益写入该原因。BigModel Start Plan 不再用 active plan 字段决定是否启用。

## 自动恢复规则

系统只会自动恢复由系统关闭的 provider：

- `enabled=false` 且 `systemDisabledReason` 有值，后续校验成功时可自动设为 `enabled=true` 并清空原因。
- `enabled=false` 且 `systemDisabledReason` 为空，视为用户手动关闭，后续校验成功也不能自动打开。

## 入口状态缓存

Model Providers 左侧入口状态会写入 `~/.zcode/v2/coding-plan-cache.json`，只缓存入口可用性，不缓存状态卡片详情。
缓存 TTL 为 24 小时，用于避免打开 Model Providers 时等待 Z.AI Start/Coding 权益查询而出现 loading 抖动。

缓存的数据源：

- Z.AI Start Plan：`https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=<ZCODE_VERSION>`，`Authorization: Bearer <zcodejwttoken>`，从 `data.plans` 判定入口可用性，从 `data.balances` 展示余额。
- Start Plan balance 请求必须同时携带 `X-Device-Mid`（来自 `telemetry-state.json` 的 `deviceMid`）；服务端把它当必填，缺失时返回 `400 {"code":3001,"msg":"parameter error"}`，客户端会判成 `unknown` 并隐藏 Start Plan 入口。桌面 host、远端 `zcode-server`、CLI 都要在首次查询前确保所在主机的 `deviceMid` 已存在，见 `docs/zcode-endpoint-device-mid-header.md`。
- BigModel Start Plan：BigModel OAuth callback 阶段不再调用 `tokenByAuthCode`，直接用一次性 callback `code/state/redirect_uri` 和 `provider: "bigmodel"` 调用 `https://zcode.z.ai/api/v1/oauth/token` 落盘 ZCode JWT；启用校验和余额查询只读取 `zcodejwttoken`，访问 `https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=<ZCODE_VERSION>`，`Authorization: Bearer <zcodejwttoken>`。
- Z.AI Coding Plan：`https://api.z.ai/api/biz/subscription/list`
- BigModel Coding Plan：当前环境 BigModel API 主域名 + `/api/biz/subscription/list`；生产为 `https://bigmodel.cn`，`ZCODE_ENV=test` 为 `https://bigmodel.cn`

自动刷新时机：

- App 启动后，后台 stale refresh；仅当本地已有 Coding Plan provider 时执行，不阻塞启动。
- `modelProviderService.getAll()` 完成预置同步后，后台 stale refresh；不阻塞 Model Providers 首屏。

强制刷新时机：

- OAuth 登录或重新登录成功。
- App 启动恢复本地登录态后。
- 设置页点击连接或刷新 Coding Plan。
- 购买或升级完成后触发刷新。
- 退出登录、unlink 或 clear API key 时立即写入不可用状态。

接口失败或返回未知状态时不覆盖旧缓存。输入框模型菜单不直接请求权益接口，只消费 provider 的 `enabled`、endpoint、
model 与本地状态。

状态卡片详情保持现状，不写入该持久缓存：

- Z.AI / BigModel Start Plan balance：`https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=<ZCODE_VERSION>`；同一次响应同时承载 `plans` 与 `balances`，不得先请求已废弃的 `billing/current`。
- Z.AI / BigModel quota：`/api/monitor/usage/quota/limit`

## Z.AI / BigModel 双入口展示

Z.AI Coding Plan 与 Z.AI Start Plan 在 Model Providers 中并行展示：

- `Z.AI - Coding Plan` 使用 provider apiKey 访问 `/api/biz/subscription/list`，接口业务成功即可保持启用。
- `Z.AI - Start Plan` 使用 ZCode JWT 访问 Start Plan billing balance 接口，`data.plans` 存在 active Start Plan 才可自动启用。

BigModel Coding Plan 与 BigModel Start Plan 使用同样的入口语义：

- `BigModel - Coding Plan` 使用 provider apiKey 访问当前环境 BigModel API 主域名 + `/api/biz/subscription/list`。
- `BigModel- Coding Plan` 使用 BigModel OAuth callback 阶段落盘的 ZCode JWT，像 Z.AI Start/Coding 一样用 `Bearer <zcodejwttoken>` 访问 Start Plan billing balance 接口；启用状态以 JWT 鉴权成功为准，不再在余额查询阶段用 BigModel access token 二次兑换。
