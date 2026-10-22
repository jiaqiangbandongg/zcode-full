# SSH 产物分享的生产接口间歇性失败

Status: needs-triage

## 已确认的运行事实

业务基线 `54ece08f23f79ae54aea1f51e0d941497d627392`，同源码 production 构建，使用已验证可用的真实账号。
Desktop 经正式 SSH 连接在 Source 上生成 `report.html`，文件包含测试标记；发布通过产品 UI 确认。

- `r3-server-20260924090435267-55e0c4` 成功发布，公开预览与下载文件均通过断言。
- `r3-server-20260924091406992-dde620`、`r3-server-20260924091613035-7dbace` 独立失败，产物已上传，停在 checking 阶段。
- `r3-server-20260924093538609-e2bdb1` 再次成功，说明不是始终不可用的账号或缺失远端文件。
- `r3-server-20260924094553403-374a70` 再次失败。对该用例专属 Source Core 的 Node HTTP 诊断事件只读观察，记录到生产
  `POST /api/v1/shares/preparations/<id>/confirm` 返回 **HTTP 503**，响应类型为 JSON。
  请求 ID：`20260924094737fb81e1d45bbdf211785c`，响应观测时间 `2026-09-24 09:48:07.717 UTC`。

HTTP 证据见 [安全字段记录](../../../packages/desktop/.e2e-artifacts/remote-stability-20260924/share-http-observation2.jsonl)；
两次独立失败的阶段见 [第一次](../../../packages/desktop/.e2e-artifacts/remote-stability-20260924/share-final-1.json)、
[第二次](../../../packages/desktop/.e2e-artifacts/remote-stability-20260924/share-final-2.json)。
观察未修改请求或响应、未保存鉴权头和正文；观察进程随用例容器回收。

## 边界与剩余调查

已确认本次失败有真实服务端 503，不能归为 WDIO 等待超时，也不能靠自动重试隐藏。
503 的后端根因尚未确定，需要按请求 ID 查分享服务或上游日志。
前两次 checking 失败与更早一次 uploading 失败未采集 HTTP 状态，不能直接断言全部同因。
界面仅显示失败阶段和“服务端未返回可定位详情”，没有可用请求 ID；错误可诊断性仍需排查。

测试已改为同时等待成功与明确失败终态，失败立即记录阶段、文案和耗时；成功仍要求下载字节对账。
两次 checking 失败分别约 12.5 秒得到终态，避免旧逻辑无条件空等 120 秒。未修改业务或服务端代码。

复现入口：在独立生产构建部署目录，以 `R3_BUILD_ENV=production R3_LIVE_HOME=<账号材料HOME>`
运行 `node harness/remote/run-queue.mjs share`。保留每次独立结果，不能只汇总成功轮次。
