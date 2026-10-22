# 修改 SSH 地址后，侧栏原地重连仍使用旧线路

Status: done

## 预期

桌面 SSH 测试指南“设备与连接管理”要求地址与凭据修改在下次连接生效，留空保留原凭据。
当前连接可以继续使用，下一次从原项目重连应使用保存后的 Connection Profile。

## 复现与证据

- 业务基线 `a13999a28927f629d0c64080a5096cf8b4f23bae`，服务器已验真构建。
- case `conversation-session-ssh-remote-connection-management.test.ts`，编辑场景。
- 批次 `r3-server-20261009183107835-42af65` 和 `r3-server-20261009221305938-a3e800`
  的 `connection-management` 均在新线路实际连接数断言失败。
- 打开同设备 A/B；在设置中修改线路名称、设备名和 SSH 端口到本 case 的转发代理，密码留空。
  原项目 session 保持原值，新代理连接数为 0，符合“下次生效”。
- 主动断开设备后，从原项目重连。项目重新取得 session，但新代理连接数仍为 0。
- 原始 Desktop 日志中的设置写入证明 Profile 端口已更新；重连日志仍连接原端口。
  之后旧端口还被注册为第二条 Profile。失败断言未放宽。

## 原回归轮次的静态定位

`reconnectRemoteWorkspaceHistoryEntry` 从 `sessionEntry.target` 创建重连目标。
`loadSourceServerProfileCredentials` 读取历史绑定 Profile 时仅取凭据，没有把 Profile 的最新
host/port/认证方式作为连接目标。因而历史 Tab 快照与 Profile 可形成两个不同的线路事实。

批次 `r3-server-20261009223735233-3b63ee` 已明确等待旧 attachment 释放后复跑，新代理连接数仍为 0；排除了按钮异步完成时序影响。业务实现不在本任务修改。
默认线路与移除设备另有独立场景，不能据此失败跳过其余管理验收。

## 根因修复（2026-10-10）

修复起点 `1ed4575f887edcc73ee3924ffd6df85d2e60aafe`，相关重连业务代码与原测试基线相同。
当前真实模块探针已复现：Profile 更新端口后，原项目重连仍传出旧端口并产生第二条 Profile；
设置页按 Profile 连接则使用新端口，单独修改密码也能被原项目重连读取。

修复在 Renderer 重连目标解析处按原项目历史绑定读取完整 SSH Profile，保持目录、Source 身份、
原线路选择和 Host 生命周期不变。旧 session 仅为无 Profile 历史提供兼容输入；没有新凭据引用且
认证配置相同时保留旧凭据引用，不复用已被切换的私钥口令。保持 sibling 复用发起方凭据与
目录 admission 失败后的同设备恢复顺序。

```text
保存：Profile（连接配置权威）更新，当前在线 session 不重启
重连：项目 identity + path -> 原绑定 Profile -> 最新 SSH target + 凭据 -> 原 Host 连接入口
成功：回填新 session / target，原 workspace identity 不变，不新增旧线路
```

验证结果：

- 新增 8 项重连行为测试，修复前 6 项失败、2 项正常对照通过；修复后全部通过。
  覆盖手动/自动恢复、新地址/用户、私钥切换、旧凭据兼容、新凭据缺失拒绝、原绑定线路选择与 sibling 凭据复用。
  原来两个只测凭据 helper 的测试已由公开重连行为测试替代。
- `pnpm test:unit:affected --base 1ed4575f887edcc73ee3924ffd6df85d2e60aafe`：
  371 个 Vitest 文件 / 4378 项用例及 28 项 Node 审计通过；未跑根全量单测。
- 根类型检查、E2E 类型检查、lint、架构与 fixture 检查通过；lint 保留 81 条既有警告。
  改动代码格式与 diff 检查通过。设计规格既有表格格式和历史分支名术语告警与基线一致，
  本次条款没有新增格式或术语问题。
- macOS Electron → 独立 Linux SSH 容器，`R3_CONNECTION_MANAGEMENT_CASE=edit`：
  `desktop-e2e-20261010-route-fix` **1/1 PASS**。新端口收到 1 次连接，密码留空后认证成功，
  A/B 项目身份保留、B 获得新 session；仍为原 Profile，设备 active Profile 数为 1。
  原“新代理实际连接数 > 0”断言保留，并补充 sibling 恢复与不得新增旧线路的断言。
- 该 run 的 `connection-management.json`、`test-results.ndjson`、运行日志和
  `build-source-evidence.json` 保留在 `.e2e-artifacts` 下。构建状态为 `fresh-stable`，
  已核对重连模块源码 SHA-256 与最终工作区一致，核对结果见 `route-fix-verification.json`。

本次完整 E2E 只复跑编辑变体；默认线路/移除的 lifecycle 变体保留原通过记录。
私钥切换由真实重连函数单测覆盖，未另跑真实私钥 SSH E2E；未重跑原生 Windows、Linux 桌面宿主或手机 relay 整链路。
不改变 WSL/Docker/Server 重连路径、RPC、Host owner 或 continuous/replayable 边界；未做人工转正或 CI 准入。
