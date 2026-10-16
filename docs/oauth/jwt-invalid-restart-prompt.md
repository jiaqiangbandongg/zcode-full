# ZCode JWT 失效提示与重启

当 Host 通过统一 `NodeApiClient` 检测到 ZCode JWT 请求返回 401 时，先复用 OAuth logout 清理本地凭据，再通过 Broadcast 通知 Renderer。Renderer 使用统一 AlertDialog 提示“登录已过期”，用户确认后写入一次性 restart marker 并执行 `RelaunchApp`。新 Renderer 启动时消费并删除 marker，强制以 `session-expired` 原因进入登录页。

```text
401 + 当前 ZCode JWT
        ↓
Host logout 清理凭据与派生 provider
        ↓
auth:zcode-jwt-invalid 广播
        ↓
Renderer AlertDialog
        ↓ 用户确认
写入一次性 restart marker
        ↓
Electron RelaunchApp
        ↓
消费 marker 并进入登录页
```

当前平台 userinfo/customerInfo、企业定价、团队订阅详情请求携带当前业务 access_token 并返回 HTTP 401 或 HTTP 200 + JSON 数值 `code: 401` 时，也复用上述流程；具体范围见 [401 自动退出](jwt-401-auto-logout.md)。空响应、其它业务错误、普通 API Key、支付/API key 管理请求不纳入新增判断。Web 端没有 `RelaunchApp`，用户确认后写入 marker 并调用 `location.reload()`，刷新后同样消费 marker 进入 `session-expired` 登录页。
