# 远程场景使用量埋点 V1

> 状态：已实现

## 目标与口径

本埋点用于回答以下产品问题：

- 有多少用户成功使用 SSH、WSL、Docker、Server 远程工作区。
- 有多少用户成功使用手机 Web Remote Control。
- Web Remote Control 从入口曝光、启动、配对到工作区 bridge 的转化情况。
- 上述场景涉及多少台桌面设备。

用户 UV 优先按 `/event/report` 公共字段 `user_id` 去重；未登录时回退按
`device_mid` 去重。桌面设备数只按 `device_mid` 去重。渗透率分母统一使用
`app_daily_active` 的同口径 UV。

V1 不统计手机物理设备数，也不统计 SSH 主机数。前者缺少稳定、合规的设备标识，后者会引入
远端主机身份和隐私风险。

## 架构边界

```text
Desktop renderer               Desktop main / manager              Telemetry core
       |                                  |                               |
       | remote connect / web entry       |                               |
       |--------------------------------->|                               |
       |                                  | terminal lifecycle result     |
       |                                  |------------------------------>|
       |                                  | 仅低基数字段 + 公共身份字段     |
       |                                  |                               |

Mobile Web -- replayable RPC --> relay/main passthrough --> shared desktop host
                 不新增 reporter         不解析 rpc-frame       bridge 成功后由桌面上报
```

- 桌面 main 只在已有连接、配对和 host attachment 生命周期的终态上报，不承载 session/task
  业务状态。
- 手机 Web 继续使用 `web-remote-replayable`；桌面继续使用 `desktop-continuous`，埋点不得改变
  两条消息链路的恢复语义。
- 外部 relay 不解析 `rpc-frame`，Web bundle 不新增独立上报器。
- 远程工作区远控继续使用 shared-host attachment，不新建 Agent runtime、local host 或远程
  session。
- 埋点失败必须 best effort，不得阻断连接、配对或 bridge。

## 事件定义

所有事件全量上报低频生命周期终态。`event_extra_detail` 仅允许下表字段，值均为字符串。

### `remote_workspace_connect_result`

触发点：用户发起的远程工作区连接在 desktop main 得到成功或失败终态时。

| 字段              | 允许值                              | 说明                     |
| ----------------- | ----------------------------------- | ------------------------ |
| `result`          | `success` / `failure`               | 连接结果                 |
| `remote_kind`     | `ssh` / `wsl` / `docker` / `server` | 远程类型                 |
| `connect_trigger` | `new` / `reconnect` / `restore`     | 新建、用户重连或启动恢复 |
| `error_category`  | 见错误分类；成功为空字符串          | 低基数失败分类           |

当前启动恢复只恢复 disconnected tab，不自动连接，因此 V1 不产生 `restore`；该枚举为后续真实自动
恢复预留，不能把 tab 恢复误记为连接。

### `web_remote_control_entry_view`

触发点：用户点击 Web Remote Control 入口并打开对话框时。

| 字段             | 允许值                                         | 说明                                   |
| ---------------- | ---------------------------------------------- | -------------------------------------- |
| `workspace_kind` | `local` / `remote`                             | 当前桌面工作区类型                     |
| `remote_kind`    | `ssh` / `wsl` / `docker` / `server` / 空字符串 | 可由统一 workspace identity 解析时上报 |

### `web_remote_control_start_result`

触发点：desktop main 处理显式启动或重新配对请求并得到终态时。

| 字段             | 允许值                                         | 说明                                       |
| ---------------- | ---------------------------------------------- | ------------------------------------------ |
| `result`         | `success` / `failure` / `cancelled`            | 显式启动或重新配对终态；`cancelled` 仅兼容历史数据 |
| `workspace_kind` | `local` / `remote`                             | 目标工作区类型                             |
| `remote_kind`    | `ssh` / `wsl` / `docker` / `server` / 空字符串 | 可由统一 workspace identity 解析时上报     |
| `error_category` | 见错误分类；非失败为空字符串                   | 低基数失败分类                             |

自动恢复已有远控运行时不属于显式启动漏斗，不产生本事件。
当前 Desktop 启动和刷新链路不再弹原生确认，因此只产生 `success` / `failure`；schema 保留
`cancelled` 仅用于兼容历史事件或其他可取消平台实现，并且不得计入失败率。

### `web_remote_control_pair_result`

触发点：桌面收到 relay 的配对终态状态变化时。

| 字段             | 允许值                                         | 说明                                    |
| ---------------- | ---------------------------------------------- | --------------------------------------- |
| `result`         | `success` / `failure`                          | 配对结果                                |
| `pair_kind`      | `initial` / `reconnect`                        | 当前 manager 生命周期首次配对或之后重连 |
| `workspace_kind` | `local` / `remote`                             | 启动远控时的目标工作区类型              |
| `remote_kind`    | `ssh` / `wsl` / `docker` / `server` / 空字符串 | 可由统一 workspace identity 解析时上报  |
| `error_category` | 见错误分类；成功为空字符串                     | 低基数失败分类                          |

相同 transport 状态重复通知不重复上报；从断开态再次进入 paired 记为 `reconnect`。

### `web_remote_control_bridge_result`

触发点：手机请求打开工作区 bridge，shared-host attachment 成功建立或失败时。

| 字段             | 允许值                                         | 说明                      |
| ---------------- | ---------------------------------------------- | ------------------------- |
| `result`         | `success` / `failure`                          | bridge 结果               |
| `workspace_kind` | `local` / `remote`                             | 目标工作区类型            |
| `remote_kind`    | `ssh` / `wsl` / `docker` / `server` / 空字符串 | 远程目标类型；本地为空    |
| `entry_kind`     | `home` / `task`                                | 打开工作区首页或指定 task |
| `error_category` | 见错误分类；成功为空字符串                     | 低基数失败分类            |

bridge 成功是“实际使用 Web Remote Control”的主口径。配对成功但没有打开工作区不计入实际使用
用户。

## 错误分类与隐私

`error_category` 只允许：

- `auth`
- `connect`
- `deploy`
- `host_start`
- `attach`
- `relay`
- `unknown`

分类器可以在本地读取错误码或错误消息，但只上传枚举值。任何事件都禁止上传：

- `workspacePath`
- `workspaceIdentity`
- `remoteSessionId`
- SSH host、用户名或端口
- Docker container
- WSL distro
- 原始错误消息或错误堆栈

## 指标计算

| 指标                          | 计算                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------- |
| SSH 使用用户数                | `remote_workspace_connect_result` 中 `result=success && remote_kind=ssh`，按 actor 去重 |
| 各远程类型使用用户数          | 同上，按 `remote_kind` 分组并按 actor 去重                                              |
| Web Remote Control 使用用户数 | `web_remote_control_bridge_result` 中 `result=success`，按 actor 去重                   |
| Web Remote Control 使用率     | Web Remote Control 使用用户数 / 同期 `app_daily_active` actor UV                        |
| 桌面设备数                    | 对目标成功事件按 `device_mid` 去重                                                      |
| 漏斗转化                      | entry view → start success → pair success → bridge success，同期分别按 actor UV         |

actor 的查询规则是 `user_id` 非空时使用 `user_id`，否则使用 `device_mid`。客户端不新增
`actor_id` 字段，也不做跨事件 UV 去重。

## 状态所有权与实现位置

| 状态 / 事实                 | Owner                                            | 埋点位置                      |
| --------------------------- | ------------------------------------------------ | ----------------------------- |
| 远程工作区连接终态          | desktop remote IPC / session manager             | IPC 返回成功或失败前          |
| Web Remote Control 入口曝光 | desktop renderer                                 | 对话框打开动作                |
| 显式启动终态                | desktop remote IPC                               | start/reset 请求终态          |
| relay 配对状态              | WebRemoteControlManager                          | transport 状态迁移            |
| workspace-scope Host attachment | WebRemoteControlManager + shared-host attachment | bridge attachment 终态        |
| 用户与桌面设备公共字段      | TelemetryCore                                    | 现有 `/event/report` 公共字段 |

## Case 规划与剪枝

必须覆盖：

- SSH/WSL/Docker/Server 新建连接成功与失败的字段稳定性。
- reconnect 显式携带 `connect_trigger=reconnect`，普通连接默认 `new`。
- 本地和远程 workspace 的入口、启动与 bridge 事件。
- 首次 paired 和断开后的 reconnect paired。
- attachment 失败只产生允许的错误分类，不泄漏目标信息。
- telemetry 上报失败不改变原业务返回值。

本期剪枝：

- 不新增 conversation/session E2E；本功能不修改 conversation 状态语义或协议。
- V1 不统计手机设备数、远端主机数、逻辑 session 并发或连接时长；逻辑 session 并发与可观测连接时长由
  [远程工作区连接 ARMS 自定义事件](./remote-usage-arms-telemetry.md)承接，ARMS 的 `active_target_count` 仅作脱敏诊断，不等价于远端主机数。
- 不为启动恢复的 disconnected tab 伪造连接事件。
- 不在 relay、Web bundle 或 `rpc-frame` 中增加埋点。
