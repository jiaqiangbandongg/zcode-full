# 卸载重装后的身份换代缺少确认入口

Status: done

> 历史验证基线：2026-09-25。本文确认入口修复仍有价值，但“保留数据重装必然产生新身份”的前提
> 已由 [Issue 08](08-reinstall-history-visible-in-new-device.md) 于 2026-10-10 的用户决策替代。
> 当前同设备重装保持身份与历史；只有独立数据环境替换才验证确认/取消/归档。以下旧批次不代表新语义通过。

## 当前证据

业务基线 `54ece08f23f79ae54aea1f51e0d941497d627392`，服务器批次
`r3-server-20260924033117390-ff1bf4` 的 `uninstall` 曾报告 PASS，但其
[运行事实](../../../packages/desktop/.e2e-artifacts/remote-stability-20260924/uninstall-full05.json)记录了另一条路径：

1. 经正式向导首装，再通过 CLI 双次 DELETE 卸载；运行文件删除，config 与用户数据哨兵保留。
2. 再次连接提示需确认身份换代，符合[Source 安装身份边界](../../architecture/r3-source-server-remote-architecture.md)。
3. 设置页“重新安装并连接”已点击。30 秒后目录面板仍存在，原项目按钮 disabled，没有错误说明。
4. 旧测试随后删除全部连接，重新新建 SSH 连接，得到新 installationId，才判为 PASS。

第 4 步证明全新安装可用，但不能证明第 3 步的恢复入口可用。旧用例因此掩盖了该入口问题。

## 测试修正与待验证

已将 `conversation-session-r3-uninstall.test.ts` 改为直接等待该入口完成安装、选择原目录并恢复 session。
失败保留目录面板与安装事实，直接 FAIL；不再删除设备换路径后报通过。

第 10 轮 `r3-server-20260924063933344-38f7b4` 在向导第 1 步等待至超时，远端已有新的 installationId。
进一步核对代码发现：设置页调用的是不带 Profile 的 `onCreateConnection`，只打开向导；真正提交连接的是
向导设备卡的 `onSelectProfile(preferred)`。该轮遗漏了选择保存线路，不能把这次超时直接定性为业务缺陷。
现已补齐该动作。第 11 轮 `r3-server-20260924070140735-f6bd8f` 的
[运行事实](../../../packages/desktop/.e2e-artifacts/remote-stability-20260924/uninstall-recheck11.json)
确认设置入口和保存线路均已点击，随后在建立链路阶段再次提示“请在连接管理中确认身份换代”。
远端 `current.json` 与新 installationId 已存在，config 和用户数据哨兵仍保留；失败点是恢复连接，
不能描述为完全没有执行安装。

补充取证批次 `r3-server-20260924091134245-eb60d2` 在再次收到身份错误后，实际关闭向导并返回连接管理。
[运行事实](../../../packages/desktop/.e2e-artifacts/remote-stability-20260924/uninstall-coverage-next.json)
显示页面仍标记“远端已卸载”，可见操作只有“重新安装并连接”和“移除全部连接”，没有身份换代确认入口。
这与源码中确认按钮位于 Profile 线路列表、而 `installState === "uninstalled"` 时隐藏该列表一致。
恢复流程要求确认身份，但指定页面没有可用入口；已获得运行证据，未修改产品实现。

验收应同时保持 [R3A-UPG-09](../../testing/r3-remote-automation-case-matrix.md) 的 allowlist、preservedPaths、
新 installationId 与用户数据对账，并验证设置页的恢复动作本身有效。未修改业务实现。

## 根因修复与验证（2026-09-25）

本节取代上文调查期间的“未修改业务实现”状态。用户已明确授权修复本问题。

根因位于 [SourceServerManagementPanel](../../../packages/ui/src/settings/SourceServerManagementPanel.tsx)：
确认按钮只存在于线路行，已卸载 Source 隐藏线路，首选线路又不在折叠的其他线路中，导致 Host
已报告 `identity-change-pending` 时仍没有确认入口。Host 的身份保护和原子替换契约本身不需要改变。

现在设备卡优先显示实际待确认线路的确认动作，多条待确认线路直接可见。所有入口复用原确认
弹窗和 `management.confirmIdentityChange`；取消不改绑定，失败显示错误并保留入口，成功消费
Host 返回的快照。没有通过改 `installState`、删除旧设备、自动接受新身份或重试来规避安全边界。

```text
之前：新 installationId → Host identity-change-pending → UI 隐藏确认 → 无法恢复
现在：新 installationId → 设备卡确认 → 用户接受 → Host 原子替换 → 从新设备选择目录
```

回归测试在原组件上先证明 5 项失败、原有 18 项通过；修复后增加多线路覆盖，相关 UI、Host
目录、连接管理与服务共 125 项通过。取消、请求中禁用、失败不自动重试、首选与非首选线路、
installed/uninstalled 都有行为断言。类型检查、E2E 类型检查、架构检查通过；lint 为 0 错误。

真实测试使用专用测试服务器、独立 Linux SSH 容器，业务基线
`54ece08f23f79ae54aea1f51e0d941497d627392` 加本修复。有效批次
`r3-server-20260925030830182-0375bb` 的 `uninstall`、`devicerow`、`uipairwise` 均 PASS；
完整输入清单 SHA-256 为 `55c831c21489c120f7a3e82ba8346c389892bade3121890c39d2b8e69263d596`。
`uninstall` 已验证取消不改原线路、确认后旧线路归档与旧历史保留、新 installationId、
新 session、配置/用户数据保留，以及从已保存的新线路选择原目录。未删除设备另走首连路径。

同一输入版本又在 `r3-server-20260925031220129-dab784`、
`r3-server-20260925031504324-c14318` 的全新容器中各通过一次，最终共三次完整 PASS，
耗时分别约 203、158、158 秒（首轮与相邻用例并发）。

首个候选批次 `r3-server-20260925030033171-139169` 已越过身份确认，但 E2E 新增的菜单
DOM click 未触发 Radix 菜单，整体 FAIL 被保留。按已有 SSH helper 改用 WebDriver 点击后，
上述完整批次通过；没有为该测试操作错误追加业务兜底。

作用域仅为桌面连接管理 UI；`SettingsPage` 的 `isDesktop` 门禁使手机 replayable 路径不使用
该面板。未改协议、身份持久化、Host/CLI 或数据迁移规则。回滚仅需撤销本次 UI 修复；不会产生
需要回迁的数据格式变化，但会重新暴露原确认入口缺失问题。
