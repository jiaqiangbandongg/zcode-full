# 目录权限收回后仍挂回为可用远程会话

Status: done

## 预期

桌面 SSH 指南的“单个目录失效”要求：目录不存在、变成文件或当前账号无访问权限时，仅该项目
失败并提示目录不可用；设备与其他项目仍可恢复。不自动重建目录或删除历史。

## 当前证据

- 业务基线：`a13999a28927f629d0c64080a5096cf8b4f23bae`，服务器构建，独立 Linux SSH 目标。
- case：`conversation-session-ssh-remote-directory-resilience.test.ts`，`R3_DIRECTORY_FAILURE_CASE=denied`。
- 批次：`r3-server-20261009170002590-cabde7`，任务 `directory-denied`。
- 步骤：同设备打开 A/B/C，保存真实 A/B 对话；切回 B，主动断开；将 A 权限改为 `000`；重连 B。
- 结果：B/C 已恢复，A 的 `remoteSessionId` 仍为非空，未按“目录不可用”保留断开状态。
  原始断言在验证 A 不可用时失败，未放宽断言。
- 静态依据：`prepareRemoteWorkspaceIdentity` 只调用远端 `FileService.stat` 并检查类型为 directory。
  Linux 对目录自身的 stat 成功并不证明当前账号可以遍历或读取其内容，因此该检查无法覆盖叶目录
  权限被撤销的情况。

## 运行身份复核（2026-10-10）

- 批次 `r3-server-20261009221305938-a3e800`，任务 `directory-denied`。
- `directory-resilience.json` 记录 SSH 用户 UID 为 1000，Core `/proc/<pid>/status` 的 real / effective /
  saved / filesystem UID 均为 1000；非 root 运行。
- 同一 SSH 用户对 A 的 `test -r` / `test -x` 为 `INACCESSIBLE`，`ls` 为 `READ_DENIED`。
- 重连 B 后，A 的 `remoteSessionId` 仍非空，第二个独立目标复跑也得到相同行为。
  B 保持原激活路径，A 没有以目录不可用状态隔离。实际拒绝与 session 挂回的记录在同一
  case 的 artifact 中，排除了测试账号特权造成的误判。

## 原回归轮次的待处理项

业务修复需检查目录可访问性与恢复门禁的关系，不能仅以目录自身 `stat` 成功认定可用。
本任务不修改业务。失败断言保持原样，后续可用相同独立故障 case 复验。

本轮按要求只记录，未修改业务逻辑。权限恢复已由 case 的 finally 完成；所有故障均发生在
该 case 的独立目标中。

## 根因修复（2026-10-10）

上述段落保留原回归批次的证据。修复基于 `5516284630ccff3552f37466266de270af661188`，
该版本的相关业务代码与原测试基线相同。

Host 的 `prepareRemoteWorkspaceIdentity` 改用已有远端 `FileService.readdir` 读取 `目录/.`。
目录元信息可读不代表目录内容可访问；末尾 `/.` 同时要求目标目录可遍历，避免只读权限
`0400` 的空目录被普通 `readdir(目录)` 放行。检查成功才绑定身份，检查路径不改变原项目身份。
错误继续映射为原目录不可用错误，只使该项目失败；不新增 RPC、不要求更新 Server、不要求目录可写。

回归覆盖真实 `000`、`0400`、`0100` 权限下的手动/自动恢复、同设备其他项目隔离、恢复权限后重试，
以及可读取和遍历但不可写的 `0500` 目录。修复前 6 项权限恢复断言失败；修复后定向单测 32 项通过，
包含真实 File RPC 与取消后迟到结果的保护。

最终验证：

- `pnpm test:unit:affected --base 5516284630ccff3552f37466266de270af661188`：405 个 Vitest 文件、4911 项用例及 28 项 Node 审计通过。
- 根类型检查、E2E 类型检查、lint、架构检查、fixture 检查和改动文件格式检查通过；lint 保留 81 条既有警告。
- macOS Electron → 独立 Linux SSH 容器，`R3_DIRECTORY_FAILURE_CASE=denied`：
  `desktop-e2e-20261010-directory-fix-denied-serial` 1/1 通过。非 root UID 1000 实际无法读取/遍历 A；
  A 保留且 session 为空，B/C 获得新 session；目录不可用提示、恢复权限后原地重试、原任务续聊与哨兵保留均通过。
  `directory-resilience.json`、截图、运行日志和源码/构建摘要保存在该 run 的 `.e2e-artifacts` 下。
- 前一轮 `desktop-e2e-20261010-directory-fix-denied` 在与受影响单测并行时，首装等待 Server ready 超时，
  尚未进入权限故障；日志同时记录本机 `ps` 启动超时。保留失败证据，待单测结束后使用同一修复构建、
  新 HOME 和新 SSH 目标单独复跑通过，不将首轮记为通过或删掉。
- 首轮构建记录为 `fresh-stable`；单独复跑沿用构建，原始记录为 `unverified-reused-build`。
  已额外交叉核验两轮全部 5286 个产物摘要一致，且首轮准入模块的源码摘要与当前修复文件一致；
  校验结果保存为复跑 artifact 的 `source-reuse-verification.json`，未改写原始构建状态。

本轮完整 E2E 只复跑失败的权限变体；删除/变文件由原完整 E2E 记录和本轮真实文件系统/RPC 单测对照。
未重新验证原生 Windows、手机 relay 整链路或 Linux 桌面宿主；未做人工转正或 CI 准入。
