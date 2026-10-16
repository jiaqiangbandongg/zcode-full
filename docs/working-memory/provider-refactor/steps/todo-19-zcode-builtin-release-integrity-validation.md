# 19 ZCode Built-in Release 完整性发布门禁

> 状态：已废弃（不再作为独立 Todo）
>
> 日期：2026-08-25
>
> 来源：Todo 18 设计复核；当前明确不纳入远端同步首版

> 2026-08-28 现状补充：阶段 B 后来已经通过
> `packages/provider-node/test/zcode-builtin-integrity.test.ts` 覆盖真实 Built-in 文件的成员重复、Model Config
> 完整解析、访问材料补齐后的 Registry 装配和禁止保存 API Key 等静态/集成证明；这不等于本 Todo 已完成。
> 发布命令、发布责任、CI 准入、误发布/回滚和客户端最小门禁仍未裁决。本文件保留为历史讨论记录，不再恢复为独立执行项；
> 未来如确需发布门禁，应按当时发布流程另立新 Todo。
> Models API 的实时目录证据工具独立记录在
> [`todo-45-models-api-publisher-evidence-tool.md`](./todo-45-models-api-publisher-evidence-tool.md)。

## 0. 任务定位

本 Todo 讨论 ZCode Built-in Provider Config 与 Model Config Rules 的业务完整性应由谁证明，以及发布流水线、
共享校验实现和客户端运行时之间如何分工。

当前裁决是：Todo 18 不新增客户端专用的 Built-in 业务完整性校验器，不注入假 API Key、假 Account
`accessId` 或假 Request Auth 来模拟 Registry 可执行。Todo 18 客户端只负责 Release Envelope、
`schemaVersion`、`revision` 和现有 Provider/Model Config Parser 的兼容解析。

## 1. 后续需要讨论的问题

- 发布者是否必须在生成 revision 前证明所有 Built-in Provider/Model 静态事实完整；
- 发布门禁如何复用仓库正式 Domain Parser，避免后端、CI 与客户端维护三套规则；
- API、Account 与 Request Auth Provider 的静态完整性如何与账号/凭据注入后的可执行性分离；
- 是否提供独立的 `zcode-builtin validate` 发布命令或等价 CI 入口；
- 发布校验失败、误发布和紧急回滚的责任与审计边界；
- 客户端除兼容解析外是否需要任何最小的业务安全门禁。

## 2. 与 Todo 18 的边界

Todo 18 继续实现：

- Bundled、Remote 与 Environment Active Cache 的两层 Release Schema；
- revision 选择、Environment 级刷新消抖、原子持久化和 Source 刷新；
- 不可解析、Schema 不支持、revision 陈旧和磁盘失败时保留当前 Active Cache。

Todo 18 不实现：

- 新的 Built-in 静态完整性规则集；
- 以当前账号或 Personal Config 判断远端 Release 是否允许发布；
- 发布服务、发布审计或业务完整性 CI。

本 Todo 不再进入执行序列，不阻塞 Todo 18 的传输、缓存和刷新能力。
