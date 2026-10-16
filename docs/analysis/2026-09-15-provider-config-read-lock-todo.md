# Provider 配置纯读取去锁 TODO

- 状态：实现、回归与自审完成；提交后推送并建立到 hotfix/3.12.2 的 MR。
- 反馈：ZCT-2099792881319157760；[调查报告](./2026-09-15-provider-config-lock-investigation.md)。
- 范围裁决：本次只处理锁竞争。读取失败保留有效配置、恢复通知与诊断明天一起设计；不修改设置持久化。

## 目标与原因

多个 Host/Agent 默认约每秒读取同一份 Personal 配置，却都参与排他目录锁，纯读也产生锁目录/owner 文件写入和删除。
应用写入已使用同目录临时文件加 rename 替换；正常读者可以观察上一次或新一次已提交文档，无需等待写者准备新文件。
普通 read 同时承担 Legacy 导入与格式规范化，不能直接删除整个读取入口的锁。

## 本次行为契约

```text
显式 read -> 无锁读取、解码
             ├─ 正式规范文件 -> 返回快照
             ├─ 文件缺失且没有 importer -> 沿用现有空配置行为
             └─ 需要导入/规范化 -> 原有写锁 -> 重读最新文件 -> 按当前内容决定是否写回

poll -> 无锁读取、解码 -> 比较内容版本 -> 沿用现有变化通知

update -> 原有写锁 -> 重读最新文件 -> transform/校验 -> 临时文件 + rename -> updated
```

- `NodePersonalProviderConfigRepository` 继续是唯一文件 IO 与轮询 owner；不增加跨进程读写锁或另一份配置缓存。
- 正常读取、纯轮询不创建锁目录，不写 owner，不因另一个正常 writer 持锁而等待；未规范化文档的显式读取仍可能等待写锁。
- 首次导入、规范化写回及修改必须在原锁内重新读取；无锁阶段的旧文档不能拿来直接覆盖写入。
- 无锁解析使用与现有读取完全相同的 decoder、encoder、内容 revision；不修改 schema、迁移脚本或文件路径。
- 写入协议、排队、锁预算、锁回收、私有临时文件及 rename 重试保持不变；兼容仍使用原锁的旧版本写者。
- 单轮 poll 完成后再安排下一轮。显式 read/update 的 finally 不能在 poll 在飞期间再排入第二轮。
- 本 Repository 有新的成功写入时，丢弃此前启动的 poll 结果，避免旧读取晚返回导致 observedRevision 倒退和重复变更通知。
  只用进程内写入代次，不修改磁盘 revision，不新增配置同步协议。
- 读者仅保证观察完整已提交版本，不增加严格的跨进程线性读取或发送前同步屏障。
- 普通读取失败后的空配置降级、poll-error 与同版本恢复规则保持现状；本次减少触发源，不宣称完整解决故障恢复。
- 不修改 Registry、UI、账号、默认选择语义或远程同步协议。默认选择、Host/Worker/Standalone 复用本 Repository；
  手机仍通过 shared-host，远程仍使用所属 Environment，desktop continuous / mobile replayable 无变化。

## 边界与验证

- 生产实现限定 `packages/provider-node/src/personal-provider-config-repository.ts`，复用 shared 公共文件工具。
- 无 UI 交互或页面结构修改；回归放在 Repository 及真实子进程文件 IO 层，复用现有 Provider 保存/默认选择/同步测试。
- Linux 本机运行验证；Windows/macOS 实机结果不得以 Linux 测试替代。Node/libuv Windows 普通文件打开包含共享删除能力，
  rename 使用替换目标文件的操作；跨平台验证仍要覆盖并发读取及替换失败。外部程序原地写坏文件、权限失败不属于本次保证。

## 执行 TODO

- [x] 明确只修锁竞争及必要的并发边界，后两项留待联合设计。
- [x] 落盘本次行为契约、验证场景及后续联合设计待办。
- [x] 先添加回归测试，并确认旧实现失败。
  - 另一进程或 writer 持锁时，正常 read 仍读到完整配置；不产生锁元数据操作。
  - 纯轮询在 writer 持锁时可观察正式文件的新版本，保持默认字段与规则一致。
  - 首次导入与规范化排队期间，另一 writer 已保存的新数据不会被旧读取覆盖。
  - 两个进程并发保存 Provider/默认选择，继续完整保留双方更新。
  - 慢 poll 与显式 read 交错不产生重叠 poll；晚到旧 poll 不覆盖新写入版本。
  - 坏文件和真实写入失败沿用原错误行为，文件原文不受破坏。
- [x] 实现纯读与写回分流，补中文原因注释。
- [x] 运行聚焦回归、相关现有测试、typecheck、lint、格式和架构门禁。
- [x] 自审实际 diff，记录测试与平台限制，提交独立 commit。

## 明天必须一起设计的两项（本次不实现）

1. 读取失败保留最后有效 Personal 数据：明确唯一 owner；区分新用户无文件、启动从未读成功、运行中失败、合法空文件、
   文件突然消失；默认选择与规则来自同一快照；保存和远程分发必须校验真实文件，不能把旧缓存当作最新写入依据。
2. 恢复通知与诊断：区分文件读取恢复和 Registry 应用完成；内容版本不变也要收敛错误状态；处理 Facade/UI 的版本去重、
   首次 start 失败未订阅、并发过期结果、Environment 换代；失败/恢复事件低频，锁排队/获取/持有/释放分阶段，
   已提交但释放失败不得伪装成未提交；不自动重放用户保存，不泄露凭据。

这两项先共同确定状态模型与影响面，再更新 spec/测试及实现，不以逐个 catch 兜底推进。

## 本次执行结果

- 生产变更仅 Personal Repository：正常 read/poll 去锁；导入、规范化及 update 保留写锁内重读。
- 新增 10 个 IO/并发测试，包括真实子进程持锁读取、旧轮询成功/错误晚返回和 ENOSPC 保存失败。
  旧实现的持锁读取测试已确认失败；过期错误测试也先确认失败再修复。
- 聚焦 Repository / Runtime / 默认选择 / 服务配置回归：5 文件、46 测试通过。
- 扩大 Provider Node 与配置分发回归：31 文件、277 测试中 276 通过。
  唯一失败为 `zcode-builtin-map-formatting.test.ts` 的内置 Map 换行断言；对应测试、
  `config/provider/zcode-builtin.json` 和 `packages/model-option-map` 与 hotfix 基线完全相同，本次未修改。
- `pnpm typecheck`、`pnpm lint`（0 error）、`pnpm architecture:check --changed` 通过；修改文件格式检查通过。
- 自审补齐 poll 在飞保护及成功写入代次校验（同时丢弃过期成功与失败），未增加第二份配置缓存。
- Linux 文件 IO 和子进程验证通过；Windows/macOS 实机及桌面/手机端到端未执行，不宣称覆盖。
- 本次不解决其他真实 IO 故障导致的空配置降级或同版本恢复漏通知。
