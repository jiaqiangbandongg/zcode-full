# BG26 429 Failure Projection Isolation Plan

**Goal:** 让 BG26 用一次真实 synthetic `429` 确定性验证 failed notification、hover 与 restore，不修改正常产品网络逻辑。

**Architecture:** BG26 worker 同时把 retry 收敛为 0，并把动态 replay server 设为 case-local HTTP proxy，强制模型请求走 Node http + 独立 `ProxyAgent` 通道；其它 worker 恢复 WDIO 启动前的环境。

## Constraints

- 不修改 `apps/zcode-cli`、`packages/ui` 或 `product-projection.ts`。
- 不增加 timeout，不改变 provider 原始错误。
- 不扩展桌面 `continuous` 或手机 `web-remote-replayable` 语义。

### Task 1: 记录并撤销被证伪的实验

- [x] 撤销 runner cleanup/abort 顺序实验。
- [x] 撤销 registry 单次 body 读取实验。
- [x] 删除 `server.maxConnections = 1` 假阳性测试。
- [x] 用真实 E2E 证明 `closeConnection` 与单独 retry=0 均不能稳定修复 BG26。

### Task 2: 隔离 BG26 worker 请求通道

- [x] 增加 focused RED test，要求 BG26 设置 retry=0、绑定当前 replay proxy，后续 worker 恢复原值。
- [x] 实现 worker-scoped 环境隔离并跑 GREEN。
- [x] 删除 BG26 不再使用的 retry fixture，运行 fixture contract check。

### Task 3: 验证并提交

- [x] 原样连续运行两轮 BG26，确认均为 1 passed。
- [x] 从 capture/log 核对一个 child 429、`maxAttempts=1`、child failed 和父 notification 原始错误。
- [x] 运行 `pnpm --filter @zcode/desktop typecheck:e2e`、`pnpm typecheck`、`pnpm lint`。
- [ ] 提交 `test(e2e): isolate BG26 failure projection`。
