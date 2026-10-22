# 保留数据卸载重装应沿用原设备身份与历史

Status: done

## 原测试预期

桌面 SSH 指南“远程机器被重装”要求确认后建立新设备、归档旧连接并保留旧历史，
不把旧历史混入新设备。

## 真实历史复现

- 业务基线 `a13999a28927f629d0c64080a5096cf8b4f23bae`。
- case `conversation-session-r3-uninstall.test.ts`，批次
  `r3-server-20261010001224807-40c41f`，任务 `uninstall`。
- 初次安装后在原项目完成真实回合，得到任务
  `sess_3b24f10d-ee85-48b9-b8ab-803cfbbff229`。
- 原安装身份 `2a4c7471-3337-4631-a43c-6129aa1ed4b6`。执行真实 CLI uninstall，
  重新安装后需要身份确认；取消保留旧记录，确认后旧 Profile 归档、新 Profile 创建。
- 新身份为 `c518b19a-5e27-4da8-b96a-3f57a0f5466b`。实际选择新设备及同一目录后，
  新设备对应项目的可见任务列表包含上述旧任务，`not.toContain` 断言失败。
- `uninstall.json` 保存原任务/身份、确认结果、保留的数据库行和
  `newInstallationTaskIds`；不是仅以文件哨兵或旧 App 缓存代替历史验证。

## 数据模型边界

Server 为兼容回退保留 legacy canonical key，本轮数据库行仍使用原 SSH route key。
`SourceServerWorkspaceAliasRepo` 按目录查找已有 canonical；App 的设备身份变化没有隔离
该 Server 用户目录中已有任务的可见性。原测试把保留数据的卸载重装当成独立设备，但远端仍是同一份用户数据。不能删除用户数据
或用安装 UUID 断言现有存储格式。

## 确认后的语义与修复目标（2026-10-10）

用户确认：保留数据卸载重装必须沿用原设备身份、连接和项目，原历史可见且可续聊。
本版本尚未上线，无需身份丢失或重复设备的存量兼容。本轮起点
`1229463da32f09989cc474e0a8641c7f5b183d40`。

根因是卸载 allowlist 删除 `install.json`，导致重装生成新 UUID，App 归档原连接并另建设备；
历史读取本身符合保留数据语义。修复在 Server 卸载边界保留既有身份标记，复用当前原子创建、
ownership 校验和卸载启动保护，不改 canonical 历史或 App 的身份路由。

原 case 改验同设备恢复；确认/取消/归档/历史隔离改用真正独立数据环境变体。
规格见 [R3 身份生命周期](../../architecture/r3-source-server-remote-architecture.md#保留数据的卸载重装2026-10-10)。

## 实施与验证

- 正式卸载保留 `install.json`，其余运行资产清理和 `uninstalled.json` 启动保护不变。
  App 继续使用同一 sourceServerId 的既有连接/项目恢复路径，不改历史 canonical key。
- 身份变化提示改为连接目标身份变化，普通安装确认不再称为“新设备”；中英文同步。
- CLI 回归先红后绿：旧实现未将 `install.json` 列入 `preservedPaths`，新实现验证身份文件原样
  保留、重新初始化不换 ID、安装完成前卸载标记仍在。相关 4 文件 / 78 项通过。
- 受影响根测试（起点 `1229463da32f09989cc474e0a8641c7f5b183d40`）：631 个 Vitest 文件 /
  6272 项与 28 项 Node 审计通过；最终安装确认文案相关 4 文件 / 15 项通过，未跑全量单测。
- 类型检查、E2E 类型检查、lint、架构、fixture 与 105 项队列合同审计通过；lint 保留
  81 条既有警告。术语扫描只命中当前规格中既有分支名，无新增命中。
- macOS Electron → 独立 Linux arm64 SSH 容器，
  `desktop-e2e-20261010-reinstall-fix-preserve-data-r2` **1/1 PASS**：正式卸载、从原项目点击
  安装确认、真实安装、原 source/Profile/项目保持、原任务可见且实际续聊；连接 session 换代。
  `uninstall.json`、`preserved-history.png` 和 `build-source-evidence.json` 保存证据，构建为
  `fresh-stable`，实际 Linux archive 的卸载清单已核对为修复内容。
- 保留数据首轮已验证真实卸载保留身份，但 case 未点击原项目交接页的安装确认就调用了
  错误页等待 helper，因“需要先确认安装”失败。补上实际用户安装确认并等错误页退出后复跑，
  未修改业务逻辑或放宽身份/续聊断言；首轮失败 artifact 保留。
- `desktop-e2e-20261010-reinstall-fix-replace-environment` **1/1 PASS**：完整封存原 `.zcode`
  后在同一 SSH 入口安装空数据环境；新 UUID 触发确认，取消保持原 Profile，确认归档旧连接、
  新建独立 Profile。原任务在封存数据库可对账，新设备可见任务列表为空，当前会话与正文
  不混入旧任务。`identity-confirmation.png`、`new-environment-empty.png`、`uninstall.json`
  与 `fresh-stable` 构建证据保留在对应 run 目录。
- 两个 E2E 均重新构建 Desktop，使用本次源码重新生成的 Server/Agent archive；
  最终 Server CLI 运行文件与 E2E 使用的 archive 对应文件 SHA-256 一致，保存为
  `final-runtime-check.json`。临时目标容器均已清理；截图检查未见遮挡或状态文案不一致。

两个变体保留 `manual-review/pending`，未做人工转正或 CI 准入。历史批次原始 FAIL 保留，
其“保留数据重装不显示旧历史”预期由本轮用户确认的语义替代。未验证原生 Windows/Linux
桌面宿主、WSL/Docker 产品连接方式或手机 relay 整链路；本次不改变 Host/协议及
continuous/replayable 边界。
