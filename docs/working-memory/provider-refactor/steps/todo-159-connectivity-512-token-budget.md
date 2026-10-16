# Todo159：连接测试输出预算统一调整为 512 Token

状态：待执行，2026-09-17 用户已确认目标值为 512。本轮仅记录 Todo 与调查证据，未修改产品代码或 Air 配置。

## 问题与实际证据

MacBook Air 的 ZCode 3.12.2 在设置页测试 OpenCode Go（Responses）的 `gpt-5.6-luna` 时失败。2026-09-17 18:00:03、18:00:06（Asia/Shanghai）的两次请求均返回 HTTP 400；请求包含 `reasoning.effort: "none"` 和 `max_output_tokens: 1`。

- 使用 Air 原有 Key、地址、Prompt 和请求参数复现，服务端原始错误为：`[integer_below_min_value] Invalid 'max_output_tokens': integer below minimum value. Expected a value >= 16, but got 1 instead.`
- 对照请求仅将 `max_output_tokens` 改为 `16`，返回 HTTP 200、正常文本与 `response.completed`。该证据证明本次连接失败由输出预算下限触发；512 尚未实测，不能把 16 的对照结果记作 512 验收通过。
- 原始失败记录位于 Air 的 `~/.zcode/cli/log/zcode-2026-09-17.jsonl` 与 `~/.zcode/cli/rollout/model-io-sess_8c93aadb-89ce-4f3e-bee9-8aaa0de12488.jsonl`。文档不保存 Key。
- 当前 [Core 连接测试入口](../../../../apps/zcode-cli/packages/core/src/runtime/methods/workspace-generate-text.ts) 将 `CONNECTIVITY_PROBE_MAX_OUTPUT_TOKENS` 固定为 `1`；[错误归一化](../../../../apps/zcode-cli/packages/adapters/src/model/failure-classifier.ts) 将该 400 显示为通用的 `Provider rejected the model request.`。错误文案优化不纳入本项。

## 已确认目标与边界

1. Core `testModelConnectivity()` 的独立输出预算统一从 `1` 改为 `512`，适用于所有 Provider 的连接测试，不增加 Luna／OpenCode 特判，不按失败动态提高预算。
2. 仍取模型公开有序推理档位首项；system `You are ZCode connectivity probe.`、user `hi` 的文本、角色及顺序保持原契约，不混入历史或工具。
3. 保留正式流与错误处理：正常 finish（含 length）即成功，允许无正文；error、缺少 finish、超时、鉴权及参数拒绝仍失败。沿用既有空响应重试，重试预算同样为 512。
4. 仅改变连接测试预算。普通会话与 Git、标题等辅助生成预算、模型输出能力上限、用户保存的配置和选择均不变；不新增配置、协议、持久化或迁移。
5. 预算策略仍由 Core 连接测试入口唯一持有，桌面、远端 Worker 和手机 shared-host 复用既有链路，保留 workspaceIdentity、owner 与 continuous/replayable 边界。

本项取代 [Todo144](todo-144-connectivity-one-token-budget.md) 的“连接测试固定 1 Token”裁决；其余契约和历史验证记录保留。512 是本次确定的目标值，不代表已验证所有上游兼容性。

## 实施与验收

- [ ] 先更新 [Settings 连接测试规格](../design/registry/settings.md)、[桌面连接测试用例说明](../../../testing/desktop-local-model-provider-p0-e2e-cases.md)及 [OpenRouter 请求契约](../../../openrouter-reasoning-request-contract.md)中仍适用的连接测试预算描述为 512，保留与本项无关的低预算 Adapter 测试。
- [ ] 先更新 [Core 测试](../../../../apps/zcode-cli/packages/core/tests/workspace-generate-text-streaming.test.ts)，证明旧实现不满足 512，再修改生产常量。继续验证最低推理档位、固定 Prompt、无正文 stop/length 成功、流异常／缺少 finish 失败，以及 Git 辅助预算仍为 5,000。
- [ ] 更新 [Adapter wire 测试](../../../../apps/zcode-cli/packages/adapters/tests/connectivity-probe-wire.test.ts)：实际序列化的 Anthropic `max_tokens`、Chat `max_completion_tokens`、Responses `max_output_tokens` 均为 512；保留协议映射、Prompt 和身份断言。
- [ ] 更新 [连接测试 E2E](../../../../packages/desktop/test/e2e/settings/manual-review/pending/provider-connectivity-prompt.test.ts)与 [Reasoning fallback E2E](../../../../packages/desktop/test/e2e/settings/manual-review/pending/provider-reasoning-fallback.test.ts)。通过真实模型行点击验证 wire 预算为 512、正常 finish 成功、400 仍失败、Personal／会话选择不变；增加能拒绝低于 16 预算的 Responses 回归场景，复现本次 Luna 的失败条件。
- [ ] 实测 Air 的 OpenCode Go / `gpt-5.6-luna` 在 512 下正常完成连接测试，记录运行版本、请求预算及终态；不以本次 16 Token 的直接 API 对照代替修改后的 App 验收。
- [ ] 按根及 CLI 子级规则执行相关测试、typecheck、lint、架构检查和受影响 E2E；覆盖受影响桌面／手机路径，远端或手机环境阻塞时明确记录未验证项。必要验证通过后自检 diff 并提交。

当前交付仅为上述待办；代码、512 真实请求和修改后 App 验收均待执行。
