# 资源管理器网络请求观测

## 已确认范围

- 网络页排在 CPU、内存、存储之后，仅展示时间、进程/PID、方法、URL；不收集 Headers、请求/响应体、SSE/WS 消息，不展示完成状态或耗时。
- 只包含本机 Main、window Host、App 自身 Renderer、受管 CLI；包含插件管理 CLI 自身请求，排除 MCP transport/鉴权、Bash/MCP 子进程、内置浏览器外部网页、远程 CLI、SSH/TCP 原始连接。
- App 自身套餐、奖励页面仍在范围内；不按 webview 类型一概排除。
- 资源管理器窗口是启停唯一 owner：未打开不安装本功能网络监听、不创建采集定时器；打开后跨 tab 继续收集；关闭、renderer 崩溃或销毁立即停止并释放记录。重新打开是新 captureId，不接收旧批次。清空也轮换 captureId 并清掉各进程待发批次，拒收清空之前的在途结果。
- 只记录监听生效后创建的请求，不补历史或此前已存在的 SSE/WS 连接。UI 显示最近 1,000 条，淘汰数量可见；不持久化。URL 去掉用户名、密码、fragment，query 值统一脱敏并限制长度。

## 实现与不变量

```text
窗口打开 → Main captureId → Chromium observer + Main Node observer
                        → 已存活/后来启动的 Host → Node observer + 本地 CLI 控制通知
CLI Node observer → 有界批次 → Host → Main 唯一列表 → 专用 preload → 网络页
窗口关闭 → 注销 observers + 通知 Host/CLI 停止 → 清缓存 → 拒收旧 captureId
```

Node 订阅 diagnostics_channel，不替换 fetch/http、dispatcher 或 Agent，不改代理、noProxy、自定义 CA、重试和取消。HTTP 代理绝对 path 还原目标 URL；CONNECT 是代理内部连接，不再记作业务请求。Chromium 使用共享 onBeforeRequest 分发器，与其他已注册的观测者（如官方版本的安全校验诊断）共存，停用本功能不注销其他观测者。

CLI 的 process/networkCapture 控制通知立即处理，不进入业务 FIFO、不等待数据库准备、不刷新 idle、不启动 CLI、不触发 watchdog。关闭连接/进程时释放监听。传输和回调异常只影响观测；批次受数量和间隔约束，stdio 拥堵时丢弃诊断批次，不积压正文或阻塞业务。

Host 仅接入本进程已有的本地 CLI 注册表，新 client 登记时继承当前采集状态。远程服务、relay、conversation continuous/replayable、owner/lease 和任务快照均不接入诊断数据。Main 只持有诊断数据，不持有任务业务状态。

## 影响面

| 等级 | 入口/owner | 变更与隔离 |
| --- | --- | --- |
| 必改 | Help/问号 → ResourceManagerApp → 专用 preload | 共享单例窗口；网络显示投影，筛选为本地 UI 状态；CPU/内存轮询显式按 tab 启用 |
| 必改 | resourceManagerWindow / desktopHostProcess / Host index | 窗口启停、Host 生命周期、带 captureId 的有界批次 |
| 必改 | Node 诊断适配器 / 本地 CLI 注册表 / stdio 控制 | 默认无监听；新进程接入；诊断不参与业务生命周期 |
| 必改 | MCP transport fetch | 异步上下文排除；原代理及鉴权行为不变 |
| 必验 | 共享 onBeforeRequest 分发器的其他观测者 / 三套代理出口 | Electron 单监听限制；直连、代理、noProxy、证书与失败路径 |
| 隔离 | Web/手机、远程 CLI、外部浏览器 | 不增加入口、不传播采集控制、不改任务恢复语义 |

代码扫描入口：ResourceManagerApp、openResourceManager、registerHostProcess、ZCodeAgentProcessManager、createMcpTransportFetch、ZCodeProtocolNdjsonConnection；沿直接调用方核对至 Host/CLI，未扩大为所有静态可达功能。desktop 当前不是 architecture-policy 的 managed module，架构门禁通过不代替运行时证明。

功能图补入网络 aliases、节点入口及窗口生命周期不变量。无待裁决的产品范围；Body、远程、原始 socket 均由用户明确剪枝，主题/平台采用代表性覆盖。

## 验收用例与证据

| ID | 设置/操作 | 断言 | 证据 |
| --- | --- | --- | --- |
| NET-01 | 未打开/打开/关闭后分别发请求 | 新监听仅在打开期间存在；重开不含旧记录 | Node 单测 + 桌面 E2E |
| NET-02 | 四种本地进程发 HTTP、SSE、WS 握手 | 每次请求一行；无正文；MCP/Bash 不出现 | 采集/Host/CLI 单测 + App 运行 |
| NET-03 | 直连、HTTP 代理、CONNECT、noProxy、自定义 CA | 业务原路由/结果不变，列表为目标 URL、无 CONNECT 重复 | 本地 upstream/proxy 集成测试 |
| NET-04 | CLI 长业务请求挂起时开关监听 | 控制立即生效、不终止业务、不触发 watchdog | 协议 transport 测试 |
| NET-05 | 新 client/Host、关闭重开、迟到通知 | 新进程继承状态；旧 captureId 丢弃；不隐式 spawn | 注册表/生命周期测试 |
| NET-06 | 高密度事件、清空、切 tab | 有界内存；清空有效；网络页不轮询 CPU；深浅主题/中英文可用 | 单测 + 桌面 E2E |
| NET-07 | 开关网络采集时已有其他 onBeforeRequest 观测者在监听 | 原观测者保留，监听失败不阻断请求 | 分发器回归（官方版本另跑安全校验诊断回归） |

先写以上回归，再实现；桌面 E2E 使用本地 HTTP 服务，不依赖真实模型或公网。发布前执行根 typecheck/lint、CLI typecheck/lint、受影响单测及资源管理器 E2E；跨 OS 未执行项如实列在提交说明。

## 实现验证（2026-09-28）

- macOS arm64、Node 24.14.0、Electron 41.0.3：根目录受影响单测 13 文件 / 95 用例通过；CLI 4 文件 / 45 用例通过。
- 真实本地 upstream/proxy 验证 Host CONNECT、CLI forward proxy、noProxy，原响应/路由不变且不重复记录 CONNECT；MCP 直连与代理均不进入列表。SSE、原生 WebSocket、ws 库握手只记录一条元数据。
- 桌面 E2E 通过：Main/Renderer 实际请求、外部 session 排除、跨 tab 采集、筛选、清空、重开无历史；深色英文/浅色中文截图已人工检查。运行记录 `desktop-e2e-20260928-030204-914`，由当前源码重新构建 App/CLI 后执行。
- `pnpm typecheck`、根 `pnpm lint`、CLI `typecheck`、`architecture:check --changed` 通过。功能图新增 seeds 可解析，无新增悬空边（原图已有 4 条）。
- 独立 CLI `lint` 仍报既有 `max-lines`，包括 debug、contracts、adapters、bootstrap 等未按独立子工程配置豁免的大文件；本次根 lint 无新增错误。额外检查 desktop `tsconfig.main.json` 仍有既有 rootDir/类型错误，本次网络模块无报错。
- 未进行 Windows/Linux 实机与企业代理自定义 CA 联调；沿用原代理/CA 实现，现有策略单测通过。此前已建立的 SSE/WS 不回填；stdio 背压下诊断可丢弃，业务协议不被限流。
