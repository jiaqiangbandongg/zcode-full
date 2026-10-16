# 安全审计报告（2026-06-09）

## 审计范围

- 仓库：`/Users/dev/workspace/z-code`
- 扫描对象：源码、配置、脚本、文档示例、当前 Git 跟踪文件、部分 Git 历史、生产依赖树。
- 重点：AK/SK 泄漏、凭据存储、Electron/IPC 暴露、Web/远控接口、命令执行、日志脱敏、依赖漏洞。
- 未做：真实渗透测试、运行时 CDP/抓包验证、第三方 relay 服务端代码审计。

## 执行命令

- `rg` 规则扫描：AK/SK、OpenAI/GitHub/Google/AWS/Slack token、私钥块、危险 API、IPC、CORS、命令执行。
- `git grep` 当前跟踪文件敏感模式扫描。
- `git log -G` Git 历史敏感模式扫描。
- `pnpm audit --prod --json` 生产依赖漏洞审计（已联网执行）。
- `pnpm lint`
- `pnpm typecheck`

## 总体结论

当前跟踪文件中未发现真实高置信 AK/SK、私钥或云厂商长期密钥明文泄漏。发现的密钥样式命中主要是文档占位符、测试假值和脱敏测试样例。

需要优先处理的真实风险有四类：

1. 生产依赖存在 19 个 high、42 个 moderate、4 个 low 漏洞，集中在 `axios`、`protobufjs`、`basic-ftp`、`fast-uri`、`mermaid`、`dompurify`、`hono`。
2. 发布脚本仍内置默认 Docker registry 用户名和默认密码 `123456`，属于可被误用的弱凭据路径。
3. Web HTTP server 的 `/ws` 和 `/api/connect-remote` 没有鉴权，若绑定到非本机或被反代暴露，会直接暴露本地/远程 workspace 服务能力。
4. 凭据加密 fallback secret 由 `platform + homedir + username` 推导，不能抵抗本机同用户或拿到配置文件后的离线解密。

## 发现详情

### P0：生产依赖存在 high 级漏洞

证据：

- `pnpm audit --prod --json` 返回：`critical=0`、`high=19`、`moderate=42`、`low=4`。
- 生产依赖总数：1246。

高风险模块摘要：

| 模块 | 当前版本 | 路径 | 风险摘要 | 建议版本 |
| --- | --- | --- | --- | --- |
| `axios` | `1.13.6` | `packages__desktop>@larksuiteoapi/node-sdk>axios` | 多个 prototype pollution、代理凭据泄漏、请求劫持、ReDoS/DoS | `>=1.16.0` 或依赖方升级 |
| `protobufjs` | `7.5.5` | `packages__desktop>@larksuiteoapi/node-sdk>protobufjs` | 原型污染后代码生成 gadget、递归 DoS、unsafe option path | `>=7.5.8` |
| `basic-ftp` | `5.2.2` | `apps__zcode-cli>proxy-agent>pac-proxy-agent>get-uri>basic-ftp` | 恶意 FTP server 可触发客户端内存/响应缓冲 DoS | `>=5.3.1` |
| `fast-uri` | `3.1.0` | `apps__zcode-cli__packages__adapters>@modelcontextprotocol/sdk>ajv>fast-uri` | percent-encoded authority/path 混淆，可能影响 SSRF/path traversal 判断 | `>=3.1.2` |

其他 moderate/low 重点：

- `mermaid@11.14.0`：CSS/HTML 注入、Gantt DoS，路径 `packages__ui>@streamdown/mermaid>mermaid`，建议 `>=11.15.0`。
- `dompurify@3.3.3`：多项 sanitizer bypass，路径 `packages__ui>@streamdown/mermaid>mermaid>dompurify`，建议 `>=3.4.0`。
- `hono@4.12.12`：JWT scheme、cookie/header、bodyLimit、JSX 注入等多项 moderate/low，路径 `apps__zcode-cli__packages__debug>hono`，建议 `>=4.12.21`。
- `electron@41.0.3`：low/moderate Electron advisory，路径 `packages__desktop>@arms/rum-electron>electron`，建议 `>=41.1.0`。

修复建议：

- 优先跑一次 `pnpm update axios protobufjs basic-ftp fast-uri mermaid dompurify hono electron --latest -r` 的可行性评估。
- 对 `@larksuiteoapi/node-sdk`、`@modelcontextprotocol/sdk`、`@streamdown/mermaid` 这类传递依赖，优先升级直接依赖；若短期不能升级，使用 pnpm `overrides` 锁定补丁版本并跑回归。
- Mermaid/DOMPurify 修复前，保持 Mermaid 渲染严格 sandbox 或关闭不可信图表渲染。

### P1：Docker 发布脚本内置默认弱凭据

证据：

- `scripts/docker-build-and-push-web-remote-control.sh:6-8`
- `scripts/docker-build-and-push-web-remote-control-test.sh:6-8`
- `scripts/docker-build-and-push-web-remote-control-v3.sh:6-8`

现状：

- 默认用户名为个人邮箱。
- 默认密码为 `123456`。
- 脚本只打印警告但仍继续 `docker login`。

风险：

- 如果 registry 仍接受该密码，任何拿到脚本的人都可以推送镜像。
- 即便密码已失效，也会鼓励 CI/本地误用弱凭据，并在日志中形成“默认密码可用”的错误预期。

建议：

- 删除默认用户名和默认密码，要求 `DOCKER_REGISTRY_USERNAME` 和 `DOCKER_REGISTRY_PASSWORD` 必填。
- 默认密码路径应直接失败，不允许继续 login。
- 轮换相关 registry 账号密码，并检查镜像仓库最近推送记录。

### P1：Web HTTP server 暴露未鉴权 RPC/远程连接能力

证据：

- `packages/server/src/http.ts:80-92`：`/ws` 建立本地服务 ChannelServer，无鉴权。
- `packages/server/src/http.ts:95-114`：`/api/connect-remote` 接收远程连接参数，无鉴权。
- `packages/server/src/http.ts:159-188`：`/ws/remote/:id` 用随机 id 取连接，无额外身份校验。
- `packages/server/src/entry-http.ts:6-7`：默认端口 3030，未显式限制 hostname。

风险：

- 若该 server 被绑定到非 loopback、容器端口映射、内网反代或调试环境暴露，攻击者可连接 RPC 服务，进一步访问 file/system/terminal/git 等服务能力。
- `/api/connect-remote` 可被滥用发起 SSH/WSL/Docker 连接尝试，形成横向探测或凭据暴露面。

建议：

- `createHttpServer` 默认显式绑定 `127.0.0.1`。
- 引入本地随机 bearer token 或 origin-bound session token；`/ws`、`/api/connect-remote`、`/ws/remote/:id` 都必须校验。
- 如果 Web 模式只用于本机开发，应在启动日志和文档中标明“不得公网暴露”，并在生产构建中禁用未鉴权入口。

### P1：凭据加密 fallback secret 可推导

证据：

- `packages/services/src/credential/providers/credentialCipherProvider.ts:23-37`
- `apps/zcode-cli/packages/adapters/src/auth/credential-cipher.ts:87-100`

现状：

- AES-256-GCM 使用随机 IV，算法选择合理。
- 如果未设置 `ZCODE_CREDENTIAL_SECRET`，密钥由 `platform + homedir + username` 推导。

风险：

- 本机同用户、拿到配置目录的本地恶意进程、或泄露了 home path/username 的环境，都可能离线推导密钥。
- 这不等价于 OS keychain / Electron `safeStorage` 的保护级别。

建议：

- Desktop 侧优先迁移到 Electron `safeStorage` 或系统钥匙串托管密钥。
- CLI/host fallback 至少生成一次性随机 master key，单独以 OS 权限保护，避免由可预测字符串派生。
- 对旧 `enc:v1` 凭据做读时迁移到新版本格式。

### P2：Electron `openExternal` 存在未校验 IPC 入口

证据：

- `packages/desktop/src/preload/index.ts:309`
- `packages/desktop/src/main/desktopMainIpcRemote.ts:90-92`

现状：

- Renderer 可通过 `window.zcode.openExternal(url)` 发送任意字符串到 main。
- main 直接 `shell.openExternal(url)`，没有协议 allowlist。
- 另一个 webview popup 路径已有 `isAllowedEmbeddedBrowserNewWindowUrl` 校验，说明项目已有相邻防护模式。

风险：

- 如果 renderer XSS、恶意 markdown/link 处理或供应链脚本能调用 bridge，可能触发非预期协议处理器。
- 影响受 Electron/OS 协议处理策略限制，但应在 main 进程做最后一道 allowlist。

建议：

- 在 main 进程统一实现 `openExternalSafe(url)`，只允许 `http:`/`https:`，必要时允许项目明确需要的自定义 deep link。
- 对拒绝项打 warn 日志，但不要记录完整敏感 URL query。

### P2：Web 远控二维码 URL 携带 `passHash`

证据：

- `packages/shared/src/web-remote-control.ts:254-283`
- `packages/desktop/src/main/webRemoteControlRelayAuthProvider.ts:17-22`

现状：

- `passHash = sha256(password)`，二维码参数名为 `hash`。
- 后续鉴权 proof 使用 `HMAC-SHA256(passHash, nonce|role|deviceSid)`。

风险：

- `passHash` 实际是 bearer-equivalent secret，而不是不可用的普通 hash；二维码截图、浏览器历史、代理日志、Referer 泄漏都可能让攻击者获得可复用配对凭据。
- 当前已有 `resetPairing`/`leaked-qr` 语义，说明泄露场景被考虑过，但 URL query 仍扩大泄漏面。

建议：

- 把二维码中的长期 `passHash` 改为短期一次性 pairing token，成功配对后由 relay/device 协商或下发持久凭据。
- 设置二维码过期时间，relay 强制校验 `t` 和单次消费。
- 移动端进入后立刻从地址栏清理 `hash` 参数。

### P2：调试 Hono server 全局 CORS

证据：

- `apps/zcode-cli/packages/debug/server/index.ts:29-31`
- `apps/zcode-cli/packages/debug/server/index.ts:107-119`

现状：

- 默认 host 是 `127.0.0.1`，这是降低风险的好设计。
- `app.use("*", cors())` 对全部调试 API 开启跨源访问。

风险：

- 如果用户通过 `host=0.0.0.0` 或反代暴露调试 server，任意网页可读取 traces/network capture 信息。
- debug API 包含 trace、network request、CA certificate 等敏感调试资产。

建议：

- CORS 默认只允许本机 UI origin；暴露到非 loopback 时要求显式 token。
- 对 `/api/network/ca.pem` 这类敏感端点增加本地 token 或启动期随机 secret。

### P3：当前本地 `.env` 含真实 OpenAI API Key，但未被 Git 跟踪

证据：

- `.gitignore` 已忽略 `.env`。
- `git ls-files` 未包含 `.env`。
- 本地 `.env` 中存在 `OPENAI_API_KEY`，长度 56。报告不记录原值。

风险：

- 当前未入库，但本地工作区存在真实密钥；后续复制、打包、日志输出或手动提交仍可能泄漏。

建议：

- 确认该 key 是否仍需要；不需要则立即删除或迁移到系统凭据存储。
- 若 key 曾用于测试或可能被终端/日志暴露，建议轮换。
- 保持 `.env` 被忽略；新增 `.env.example` 时只写占位符。

### P3：Git 历史中曾提交 `.env.production` 占位 OSS 字段

证据：

- `.env.production` 当前只包含生产链接常量和公开 OAuth client id，不再保存当前产品环境选择。
- `git log -- .env .env.production .env.local .env.e2e.local` 显示 5 次相关历史。
- 历史提交 `60345957e` 的 `.env.production` 曾包含 `OSS_ACCESS_KEY_ID` 和 `OSS_ACCESS_KEY_SECRET`，长度均为 7，掩码形态分别为 `yo***ak` / `yo***sk`，判断更像占位值而非真实 AK/SK。

风险：

- 当前未发现真实 OSS AK/SK，但环境文件曾被纳入版本历史，说明流程上曾允许敏感配置进入 Git。

建议：

- 若无法确认这些值绝对是占位符，仍按泄漏处理并轮换相关 OSS 凭据。
- 加入 secret scanning pre-commit/CI，例如 gitleaks 或 trufflehog。

## 已确认的正向控制

- `.gitignore` 已忽略 `.env`、`.env.local`、`.env.*.local`。
- 日志导出存在敏感字段脱敏逻辑，覆盖 token、authorization、password、api key、URL query 等，并有 UTF-16 相关 bugfix 注释和测试。
- Electron 主窗口开启 `contextIsolation: true`、`nodeIntegration: false`。
- webview popup 路径已有 URL allowlist 和 window open deny 策略。
- 远程 SSH 密码/私钥 passphrase 通过 credential service 保存，不直接写入 workspace history。

## 验证结果

- `pnpm lint`：通过，0 error，74 warning（均为既有未使用变量/导入等 lint warning）。
- `pnpm typecheck`：通过。
- `pnpm audit --prod --json`：失败退出码 1，原因是存在漏洞；联网审计成功返回漏洞清单。
- `git status --short`：审计前干净；本报告文件为本次新增。

## 建议修复优先级

1. 依赖漏洞：优先处理 `axios`、`protobufjs`、`basic-ftp`、`fast-uri`、`mermaid`/`dompurify`。
2. 删除 Docker 发布脚本默认弱凭据，并轮换相关 registry 账号。
3. 给 `packages/server` HTTP/WS 入口加本地绑定和鉴权。
4. 改造 credential master key：从可推导 fallback 迁移到系统钥匙串或随机 master key。
5. main 进程统一校验 `openExternal` URL 协议。
6. Web 远控二维码改短期一次性 token，并清理 URL query。
7. CI 加 secret scanning，阻止 `.env*` 和高置信密钥进入仓库。
