# 冷启动未补齐已打开的另一远程工作区

Status: done

业务基线 `d31e735905cf744e75a0a93548a80acabe871ae5`，测试补丁 07。
批次 `r3-server-20261011125749338-152f05` 的 `mixed` 在 407.4 秒后失败。

## 实际证据

`mixed-entries.json` 在重启前记录同一 Source 的 A/B 两个 workspace 都在线，identity 不同，
active 为 A；持久化 entries 也明确包含 A/B。不是仅有两个项目 membership、却从未打开 B。
冷启动早期仅有 A 的导航项；后续等待 240 秒始终没有同时观察到 A/B 恢复。

Main 旧进程在重启前分别确认 A/B workspace-context-bound 与 ready。退出后，新 Main
于 21:00:23 仅记录一条 connect ready，sessionId 与等待中已上线的 A 一致；未见 B 的
新 ready/bound 记录。不能将这个现象仅归为导航缓存遗漏而宣称两个 attachment 都恢复。

同批 `boundary` 以 B 为最后激活项，冷启动只观察到该项的连接，等待 A 180 秒失败；
该例还记录了 Profile 凭据由存在变为缺失，见[问题 11](11-ssh-credential-missing-after-restart.md)。
两项之间是否存在共同根因尚未确认。

同批 `rdux14` 在 251.2 秒后失败：只把 B 的 lastOpenedAt 设为 8 天前，冷启动却先在等待
未设过期的 A 时失败，active 仍指向 B。新 Main 仅有一次 connect ready；日志还有一次
credential.delete。该结果不能归为“8 天过滤仍存在”，B 的独立恢复断言尚未到达。
`coldreconnect` 同批也停在冷启动后的 A 恢复等待（291.1 秒），均保留原自动恢复断言。

```text
重启前：A online + B online，持久化 open set = {A, B}，active = A
冷重启：旧 Main/Host 退出 → 新 Main/Host → A ready
后续：B 没有补齐（240 秒观察）；原 active 仍为 A
```

## 合同与范围

[当前 Renderer 恢复合同](../../remote/desktop-remote-session-renderer-reattach.md) 要求 Source 上线后
恢复该窗口全部 open、断连、stable identity 项目，不因工作区年龄或上次连接状态遗漏 sibling，
同时保持原焦点。当前运行结果未满足全部恢复。

需核对启动 open set、Source 上线与 workspace attachment 恢复之间的交接。
本记录不推断历史数据被删除，也不将 Source 已连接视为每个 workspace 已恢复。
本轮保留业务实现；测试只补齐失败时的实际时间线诊断，没有加手动点击代替自动恢复。

证据目录：`packages/desktop/.e2e-artifacts/r3-server-20261011125749338-152f05-mixed/`；
同批 run log 保留旧/新进程的 ready 和 bound 记录。

## 2026-10-12 凭据修复后的复验

批次 `r3-server-20261012003650390-d1994e` 使用 `bc61ed5cc9` 加问题 11 的凭据清理修复，
重新构建业务产物；本项恢复逻辑未改。`mixed` 仍在 404.6 秒失败：冷启动观测只有 A online，
B 未补齐；`boundary` 仍在 326.6 秒失败：active B，等待 A 的 identity/session 收敛超时。
只读运行探针确认两例均为 passwordRefs=1、presentRefs=1，boundary 结束证据也保持 1/1。
因此凭据误删已不能单独解释这些恢复失败；不将问题 11 的修复扩大为本项已解决。
`coldreconnect` 同批仍为 FAIL（242.3 秒），完整批次结果另见问题 11。

`project-order` 为 FAIL（234.4 秒）、`rdux14` 为 FAIL（220.0 秒），均停在等待 A 恢复且
active 仍是 B；运行中密码引用与实际存在均保持 1/1。后者未进入 8 天前 B 的独立断言，
不据此判定年龄过滤。`recov` 已通过，证明不能把所有恢复路径统一判为失败。

## 2026-10-12 根因复核：撤回“冷启动丢 sibling”的业务定性

适用版本仍为 `bc61ed5cc9` 加问题 11 修复。五项失败的运行时 settings 日志均同时存在：
旧 `lastWorkspaceSession` 的 A/B 投影，以及新版 `lastActiveWorkspace` 的单一活动目录。
`mixed` 的活动目录为 A，其余为 B；实际冷启动恢复与活动选择一致。
`readPersistedWorkspaceSessionEntries` 在新字段存在时只返回活动目录，是虚拟项目规格 F5
的明确要求，不能为了满足旧用例而改回读取旧列表。此前远程文档把旧 open-set 合同当成新版合同，
导致问题归类和测试期望错误；本节撤回上文“必须冷启动补齐所有 sibling”的定性。

真实模块探针以同样的活动选择/旧 A+B 投影输入调用读取与恢复函数：A/B 两种活动选择均只生成
一个对应 tab、没有 deferredRestore；连同相邻旧版导入覆盖 30 项通过。原真实失败是端到端证据，
该探针验证首次缩减候选的确定性边界，不冒充额外完整 App 复现。

`project-order` 需单独纠正：旧失败实际位于第 102 行（手动 connectHost 后等未激活 A tab），
第 88 行冷启动恢复 B 已完成。运行日志同时确认 connectHost 成功；按 G3/F5 连接设备只刷新
已保存的项目入口，不为未激活目录创建 Renderer tab。排序用例应断言项目 online 与顺序保留。

```text
新版活动选择 A + 旧投影 A/B → reader 返回 A → A attachment ready（符合 F5）
旧测试继续等待 B 自动出现 → 超时 → 被错误归类为业务失败
修正验收：A 自动恢复 + A/B 项目入口保留 → 用户打开 B → B attachment/任务可用
```

推荐修复仅调整五项 E2E、对应验收文档，补充新版远程活动目录单测；不改恢复业务逻辑。
RDUX-14 直接把权威活动 B 的 lastOpenedAt 设为 20 天前，而不是只改不会参与新版恢复的旧字段。
实施状态：已修正测试与文档，没有修改恢复业务逻辑。验证状态：计划内必要验证通过。

### 最终定向复验

批次 `r3-server-20261012012923737-60d156`，业务构建沿用问题 11 的已验真修复产物，
完整源码清单 SHA-256 为 `b7ef08e140b79ff69cda860e617b4f910fc6971e4b56f1780cf6d31bc82811c7`。
本批只同步 E2E/WDIO 运行输入；本机新增的单测与文档不影响此业务构建。

| 用例          | 结果           | 保留的有效验收                                                       |
| ------------- | -------------- | -------------------------------------------------------------------- |
| boundary      | PASS，141.6 秒 | 活动 B 自动恢复，重启后目录读取成功，密码引用/存在均 1/1，说明不重复 |
| mixed         | PASS，156.3 秒 | 自动恢复 A、项目入口不丢、B 按需打开、独立 session、原任务续聊       |
| coldreconnect | PASS，186.8 秒 | B 自动恢复原会话，A 按需打开，双方续聊，自动重连关闭及手动恢复       |
| project-order | PASS，142.8 秒 | 拖拽、冷重启、断开/连接后的项目顺序和在线状态                        |
| rdux14        | PASS，132.4 秒 | 权威活动 B 设为 20 天前仍自动恢复，A 按需打开，共用一个 Host         |

受影响 Vitest 共 408 文件 / 4531 项通过，Node 脚本 34 项通过；类型、lint（207 条既有警告）、
架构、5 项 fixture、格式和链接检查通过。本项不是放宽产品行为，也没有删除失败分支来转绿。
问题 25 的诊断用例另为 FAIL，已取得预期失败的原始 Worker 证据，不计入上述五项修复验收。
