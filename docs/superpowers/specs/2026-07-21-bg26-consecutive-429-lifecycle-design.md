# BG26 429 Failure Projection Isolation Design

## 目标

稳定 BG26 的 case-local synthetic `429` replay，验证 provider 原始错误进入 background subagent failed notification、失败 hover 与 snapshot restore。BG26 不新增或修改产品侧主模型 retry、queue、stream recovery 语义。

## 运行时证据与根因

早期失败 run `desktop-e2e-20260721-110945-241` 中，child attempt 1～6 到达 replay server，attempt 7 只有 `model.request.started` / `model.network.started`；其它 run 的停点会漂移。下列实验均被真实 E2E 否定：

1. 调整产品侧 stream cleanup/abort 顺序后，focused test 通过，但 BG26 仍卡在物理请求发送前。
2. 显式关闭 429 响应连接后，run `desktop-e2e-20260721-121455-420` 收到第一个 429，却在 attempt 2 发送前卡住。
3. 仅把 BG26 retry 设为 0 后，run `desktop-e2e-20260721-122552-864` 已记录 child `attempt=1/maxAttempts=1`，但首个物理请求仍未到 replay server。

因此失败不在 projection、hover、snapshot restore 或产品错误转换。BG26 作为 projection case 同时继承了产品默认 retry 和进程级 global fetch 通道；父请求完成后，child 请求在该共享测试通道上可能停在 replay server 之前。把 retry 降为一次只能缩小 case 语义，不能单独隔离不稳定通道。

```text
旧链路
  parent title / launch / ACK
    -> 进程级 global fetch 通道
  child 429（默认还会 retry）
    -> 某次或首个 attempt 只有 network.started
    -X-> replay server
    -> child 无 terminal failed
    -> 父 notification 永不到达

目标链路
  BG26 worker
    -> retry = 0
    -> ZCODE_HTTP_PROXY = 当前 replay server
    -> Node http + 当前请求独立 ProxyAgent
    -> 1 次真实 429
    -> child terminal failed
    -> parent failed notification
    -> live hover
    -> 切换任务后的 snapshot restore
```

## 方案

采用 case-local worker 隔离，不修改产品网络代码：

1. WDIO `beforeSession` 根据当前 worker specs 判断 BG26，仅该 worker 设置 `ZCODE_MODEL_RETRY_MAX_RETRIES=0`。
2. replay server 启动并获得动态端口后，仅 BG26 worker 设置 `ZCODE_HTTP_PROXY` 为该 server 的 base URL，并清空显式 `ZCODE_NO_PROXY`。`ProxyAgent` 会发送 absolute-form HTTP URL，而 replay server 已支持该格式。
3. 非 BG26 worker 和 capture 模式恢复 WDIO 启动前的 proxy/no-proxy 配置，避免串扰其它 case 或开发者环境。
4. BG26 fixture 保留一次真实 `429 AccountRateLimitExceeded`、原始 provider message 和 `retry-after: 0`，删除不属于本 case 合同的 retry fixture。
5. provider message、status code、child marker、notification matcher 和 UI/restore 断言保持不变。

该边界与 conversation case catalog 中 BG26 的已确认语义一致：`429` 只作为真实失败代表，不定义主模型 retry/queue 语义。产品默认 retry 仍由 adapters focused tests 覆盖。

## 影响边界

- 只修改测试基础设施、BG26 fixture/manifest 与定向测试。
- 不修改 `apps/zcode-cli`、`packages/ui`、`product-projection.ts`、conversation projection 或 E2E timeout。
- 桌面 `continuous` 与手机 `web-remote-replayable` 的运行态、snapshot 和恢复边界均不改变。

## 验证结果

- Worker isolation 与 replay server focused tests：`8 passed`。
- BG26 fixture contract：`5 fixtures`，通过。
- 原样 BG26 连续两轮通过：
  - `desktop-e2e-20260721-123822-673`
  - `desktop-e2e-20260721-124220-804`
- 两轮 capture 都是 5 条 complete 请求，child 只有一个 `429`；Agent 日志记录 `attempt=1/maxAttempts=1/statusCode=429`，随后出现 `turn.failed`、`subagent.background.failed` 和父 notification 请求，原始 provider message 保留。
