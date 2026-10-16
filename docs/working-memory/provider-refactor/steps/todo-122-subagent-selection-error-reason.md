# Todo122：保留并展示 Subagent 模型选择失败的具体原因

> 状态：2026-09-11 本轮授权后实现并完成局部 review；84 项 Core 测试、两项浏览器详情/复制用例通过，整批最终验收待执行。未确认的启动现场根因仍不在本项修复范围。

## 本轮实现与证据

- 只改选择错误构造：六种公共原因进入既有 `context.reason`，短双语说明同时进入 message，兼容后台仅保留 message 的路径。原选择只以 selection 标注；有效身份仅取解析结果，不伪装成已执行模型。没有改解析、继承、override、持久化、权限或调度。
- 先在正确的 Core Vitest 入口确认新增七项断言失败，再实现。六原因经真实公共投影/工具结果/父模型内容验证；真实前后台 runner 在启动前失败并保留原因，不发模型请求。五文件 84 tests 通过。
- 真实 ToolLayout 的详情和复制在 390 中文浅色、1200 英文深色浏览器用例通过，复制包含稳定原因及完整身份。fixture 的工具错误由测试注入，并非跨进程实机故障；未测真实手机 shared-host/Electron。截图沿用三行截断，复制保留全文；Linux 缺中文字形不算字体视觉验收。
- Core typecheck、变更文件 lint、架构检查通过。Core 全量 lint 仍有既有超长文件错误，未为此扩修。review 确认公共错误与后台 message 两条消费均不再丢原因，无 Key/Header/配置全文写入。

## 已确认的问题

`resolveSubagentSelection` 将不同失败统一抛成 `Select an available model before starting a subagent`，具体原因仅放在 `context.selectionIssue`。公共错误投影读取 `code`、`reason` 等字段，但不读取 `selectionIssue`，因此具体原因没有进入工具结果与 UI 详情；父模型也只能看到笼统的配置错误。

离线调用真实选择检查及错误投影，确认账号连接不可用、Provider 不存在、模型不存在、档位缺失、档位不支持五种原因最终得到相同的消息和 `CONFIGURATION_ERROR`，没有可区分的详情。原始 CLI `tool.call.failed` 文件日志仍可保留 `error.context.selectionIssue`，不能描述为所有日志都丢失。

## 目标与实现约束

```text
公共选择解析的实际失败原因
  → Subagent 错误构造
  → 既有公共错误投影／工具结果
  → 父模型、桌面和手机远控错误展示
```

- 复用公共解析已返回的原因，不在 UI 或错误层重新判断账号、Provider、模型或档位是否可用。
- 优先在 Subagent 错误构造处对齐既有错误契约，例如稳定原因进入已有 `context.reason`，必要身份进入已有 Provider／Model 字段；避免为单个工具扩展一套专用错误协议或在通用错误层硬编码 Subagent。
- 用户能区分：未选择模型、当前账号连接不可用、Provider 不可用、模型不存在／不可用、未选择思考档位、思考档位不支持。面向用户的文案兼顾中英文；稳定原因供机器判断，不能依赖展示文案解析。
- 前台和后台启动失败均保留原因，错误详情及复制内容不能再次退化为单一句“先选择可用模型”；父模型的工具结果也应拿到具体原因，不只改 UI。
- 只使用失败时已有的事实补充上下文，区分原选择与有效选择，不把原 Provider 冒称为重映射后的执行 Provider。不额外查询账号或发模型请求，不输出 Key、Header、配置全文或会话正文。
- 不改变失败条件、有效选择解析、继承及内部 override 的优先级；不自动补档位、不回退父模型、不替换 Provider、不改持久化数据。
- 实施前更新对应 spec，并遵循工具变更链路要求；先补有区分力的测试再改代码。保持小范围修复，不重做整个错误系统。

## 验收与 review

- [ ] 覆盖上述全部选择失败原因，检查稳定原因、可读信息及必要身份；正常显式选择、继承和内部 override 行为不变。
- [ ] 通过真实公共错误投影和工具结果链路验证，不只断言抛出的 Error.context；前台／后台均有覆盖。
- [ ] UI 交互 E2E 验证失败提示、详情及复制内容；兼顾桌面与手机远控、双语，不改变现有实时传输边界。未执行的验证如实记录，不据此关闭。
- [ ] 确认原始日志仍可定位、不会泄露敏感信息；失败后不偷偷启动其他模型或写回选择。
- [ ] 合批运行相关测试、类型检查、lint，并完整 review 本项要求后再标记完成。

## 现场调查背景（不属于本项修复）

报告条件：新版本、本地工作区；截图中内置 general-purpose 显示 GLM-5.3／最高，启动却报上述错误。尚未取得该机器失败时的实际选择和 `selectionIssue`，不能宣布已找到现场根因。

两条待核实线索：已有 Runtime 未读取后来保存的 Subagent 配置；用户／项目同名 profile 覆盖了设置页展示的内置 profile，项目配置还可能保留未迁移的旧 Provider。若确实是保存后新建的 Runtime，第一条不解释首次失败。两者均不作为已确认 Bug 在本项顺带修复，也不在此重议配置刷新策略。

旧版隐式默认档位迁移后缺失是另一个条件性复现，但不能直接解释当前新版本截图显示“最高”的情况。本项不顺带制定或实施档位补值迁移。

## 代码入口

- `apps/zcode-cli/packages/core/src/runtime/helpers/subagent-selection.ts`
- `apps/zcode-cli/packages/core/src/errors/error-payload.ts`
- `apps/zcode-cli/packages/core/src/tool/executor/errors.ts`
- `apps/zcode-cli/packages/core/src/subagent/runner.ts`
- `apps/zcode-cli/packages/adapters/src/logging/serialize.ts`
- `packages/ui/src/ToolCallBlocks/ToolLayout.tsx`
