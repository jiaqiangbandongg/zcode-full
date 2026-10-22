# Remote connection flow

连接向导的单一 hook owner；控制器在同一闭包持有表单、当前阶段、requestId 与 entryEpoch，不维护第二份连接或项目真值。

`requestRemoteProjectConnection` 是已有项目向此 owner 交接失败的公共入口，原目录与 Host 确认的升级 `profileId` 一并保留。向导按最新快照核验该线路，并以实际连接参数继续；不从 WSL 的省略用户参数猜测账户。该入口从 Root 移入本模块，侧栏与 Root 共同消费 `contract.ts`。

原项目异步交接保存非敏感 failedTarget，避免先读取最新 Profile 丢失旧目标或混入新凭据。升级恢复在使用最新 Profile 前核验失败目标身份；WSL 安装与升级均使用 Host 的已解析身份。更新及 force 确认传递同一个非敏感 expectedTarget，由 Host 在执行入口再次校验并固定目标；同 ID 改址终止旧恢复并提供重试，不跟随新地址。

首次安装失败同样保留 Profile，并以 Host 的 `resolvedWslTarget` 固定 WSL 实际发行版与用户；安装预览读取失败不改变该目标。连接目标被接受时同步 WSL 表单，省略项清空，返回配置不会恢复旧输入。既有 requestId/entryEpoch 撤销规则同时覆盖安装等待、迟到快照和旧确认。

```text
显式打开 → 连接/安装/升级 → onConnectionReady → 项目 owner 选择并保存目录
                        ├→ device-management → 释放独占 attachment → 交付入口 owner
                        ├→ 明确原项目 ID/目录 → onSelectProject → 恢复原项目
                        └→ 既有目录步骤 → onSelectProject
关闭/换入口 → 递增 entryEpoch → 迟到连接、确认与目录结果失效
```

device-management 无指定 Profile/Source/Target 的新建入口直接进入默认 SSH 的分类表单。类型内的发现候选只填写配置，显式提交才连接。切换类型或 SSH 目标清除旧凭据，迟到发现结果不得重写其他类型的选择。device-management 的完成回调只交付 Source 身份；新增按钮明确为「添加并连接」。原目录和旧调用方默认完成行为保持不变。

Source 管理器仍拥有连接与身份；onConnectionReady 接管项目创建时不准备会话。临时 attachment 取消和设备连接生命周期保持独立。最小化保留请求，真正关闭释放意图；force-update 的待确认 Promise 在卸载时完成为 false。

index 保留完整 hook，调用和副作用顺序与原实现一致；不为行数限制拆散流程。桌面 continuous、手机 replayable 均复用原服务，不在此模块重写传输或持久化。

## 后台操作与显式继续

```text
Root 唯一连接 flow → 后台 visibility → 设置设备卡/未完成项（只读投影）
                         ├─ 失败/待处理 → 查看同一 flow，不重新连接
                         └─ 成功 → 一次性结果 → 显式继续 → 有效原 owner
取消/入口替换 → 撤销 entryEpoch → 旧结果、旧继续、迟到确认均无副作用
```

项目目录、已有项目、草稿新增设备和聊天均使用 Root 的连接入口。后台完成不调用导航或原 owner；显式继续一次消费当前 entryEpoch 的结果。设置仅展示同一操作，不存连接或日志副本。后台取消通知原 owner 解除挂起，但不激活原 tab。Host 连接事实、凭据、continuous/replayable 边界不变。

已有设备的 `connect-device` 返回意图保持原项目页签，连接成功后继续目录或已有项目选择。只有 `add-device` 返回意图进入设置；两者复用 Root 的同一 flow。显式后台继续期间的快照读取失败也必须校验 entryEpoch，取消或替换后的旧失败不得重开弹窗。

Root 在已有流程占用入口时，只重新打开原流程，不接受第二个连接意图。受控 `open` 从关闭变为打开，也必须进入同一个后台恢复入口：在途请求解除后台标记，已完成请求一次消费完成动作；不能只改变弹窗可见性。恢复卡片、完成通知和普通设置入口复用同一结果与 entryEpoch，重复恢复不重复连接或导航。

首次主动连接成功的完成入口先显示原版持续运行介绍，点击「知道了」才持久化 `remoteBoundaryIntroAcknowledgedVersion: 1`，再继续现有完成分支；后台完成延迟到显式继续。每次 await 后核对 entryEpoch，失效意图不能写已读或继续导航。目录与项目表单不再自动标记已读。新标记缺失（含旧字段版本 2）统一补看一次；旧字段不再判断已读，存量版本 3 由设置 owner 迁移。

首次介绍遇到已有确认框时，由 flow 保留完成动作，确认框释放后重入；确认关闭或换入口则撤销该动作。读取已读状态、等待确认或保存期间收起，都转交同一后台完成入口，显式继续后才弹介绍或交付结果。

```text
连接成功 → 已有确认占用 → flow 保留完成 → 取消关闭 → 介绍 → 原完成
                         └→ 确认关闭/换入口 → epoch 失效 → 丢弃
读取/保存介绍 → 收起 → 后台保留 → 显式继续 → 校验设备 → 原完成
```

设备完成回调可以等待原 owner 的异步资格校验。flow 传入基于现有 entryEpoch 与 minimizedRef 的可交付谓词；返回方在导航前核对，期间收起只转交既有后台完成入口。回调拒绝沿用连接错误、重试与取消，不能转换为取消来提前解锁。显式后台继续后再次收起时，迟到错误只更新同一后台操作，不重新弹窗。

后台完成通知与进度卡的显式继续先同步恢复前台可见性，再读取 Source／成员资格。Root 通过原可见性通知恢复发起聊天的提交门禁；异步校验不能留下可发送到旧目标的间隙。取消、再次收起和失效意图沿用原清理规则。
