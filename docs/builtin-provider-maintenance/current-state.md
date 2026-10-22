# 当前配置与维护状态

新增候选、公开目录缺项和规则解析差异见[扩展计划](./expansion-plan.md)。下文仍记录 revision 33 的实际配置；研究建议尚未实施。

## 基线与口径

- 检查日期：2026-10-14（北京时间）。代码基线：staging `68fac8de4fcc69972dc8c0a44b939702d3c571ea`，产品源码版本 3.15.3；不表示该版本已发布。
- 正式/测试均为 schemaVersion 1、revision 33。本次文档 MR 未修改配置或 revision。
- 21 个普通 API 模板，10 个固定账号 Provider；模板成员共 246 条，包含跨模板重复型号。
- Model 规则 83、Model+API 规则 73、正式 Site 规则 54、测试 Site 规则 63、模板精确规则 248、固定 Provider 精确规则 30。
- 正式文件 SHA-256：`361b778f89496a37540d23a9d309efe6cb8fc97d557119cefbffc67df2f93998`。
- 测试文件 SHA-256：`ae897a66877b52ff4b227e2a972e9a1aa15ac33de7493ab78d72a15dd68c6374`。hash 针对基线 Git 内容（LF）；本地 CRLF checkout 需要按仓库换行归一后比较。

清单直接从[正式 JSON](../../config/provider/zcode-builtin.json)提取。下面的启停是模板精确规则，不包含用户覆盖或实际 Key/权益；存在于列表不等于该入口在本轮已真实验证。

## 模板摘要

| templateId                       | 协议                      | 成员数 | 默认启用数 |
| -------------------------------- | ------------------------- | ------ | ---------- |
| `zai-api`                        | `anthropic-messages`      | 2      | 2          |
| `zai-standard-api`               | `openai-chat-completions` | 24     | 2          |
| `bigmodel-api`                   | `anthropic-messages`      | 2      | 2          |
| `bigmodel-standard-api`          | `openai-chat-completions` | 24     | 2          |
| `moonshot-kimi`                  | `anthropic-messages`      | 6      | 3          |
| `minimax`                        | `anthropic-messages`      | 8      | 3          |
| `deepseek`                       | `anthropic-messages`      | 2      | 2          |
| `qwen-alibaba-model-studio-cn`   | `anthropic-messages`      | 13     | 2          |
| `qwen-alibaba-model-studio-intl` | `openai-chat-completions` | 14     | 2          |
| `xiaomi-mimo`                    | `anthropic-messages`      | 4      | 4          |
| `xiaomi-mimo-token-plan`         | `anthropic-messages`      | 2      | 2          |
| `openai`                         | `openai-responses`        | 10     | 4          |
| `anthropic`                      | `anthropic-messages`      | 5      | 5          |
| `xai`                            | `openai-responses`        | 3      | 2          |
| `openrouter`                     | `anthropic-messages`      | 59     | 11         |
| `opencode-go-chat`               | `openai-chat-completions` | 15     | 8          |
| `opencode-go-messages`           | `anthropic-messages`      | 8      | 3          |
| `opencode-go-responses`          | `openai-responses`        | 2      | 2          |
| `opencode-zen-responses`         | `openai-responses`        | 14     | 2          |
| `opencode-zen-messages`          | `anthropic-messages`      | 15     | 5          |
| `opencode-zen-chat`              | `openai-chat-completions` | 14     | 10         |

## 完整成员与默认启停

这里保留全部模板成员，便于评审增删；能力和参数不抄成另一套配置，按[规则合同](./configuration.md)解析。后续配置 MR 同步更新本节、摘要及基线。

### zai-api

- Base URL：`https://api.z.ai/api/anthropic`；Access：`zhipu-coding-plan-api-key`。
- 默认启用：`GLM-5.3`、`GLM-5.3-Flash`。
- 默认关闭：无。

### zai-standard-api

- Base URL：`https://api.z.ai/api/paas/v4`；Access：`api-key`。
- 默认启用：`GLM-5.3`、`GLM-5.3-Flash`。
- 默认关闭：`GLM-5V-Turbo`、`GLM-5.1`、`GLM-5.1-Highspeed`、`GLM-5`、`GLM-5-Turbo`、`GLM-4.7`、`GLM-4.7-FlashX`、`GLM-4.7-Flash`、`GLM-4.6`、`GLM-4.5-Air`、`GLM-4.5`、`GLM-4.6V`、`GLM-4.6V-Flash`、`GLM-4.6V-FlashX`、`GLM-4.1V-Thinking-FlashX`、`GLM-4.1V-Thinking-Flash`、`GLM-4-FlashX-250414`、`GLM-4-Flash-250414`、`GLM-4V-Flash`、`codegeex-4`、`charglm-4`、`emohaa`。

### bigmodel-api

- Base URL：`https://open.bigmodel.cn/api/anthropic`；Access：`zhipu-coding-plan-api-key`。
- 默认启用：`GLM-5.3`、`GLM-5.3-Flash`。
- 默认关闭：无。

### bigmodel-standard-api

- Base URL：`https://open.bigmodel.cn/api/paas/v4`；Access：`api-key`。
- 默认启用：`GLM-5.3`、`GLM-5.3-Flash`。
- 默认关闭：`GLM-5V-Turbo`、`GLM-5.1`、`GLM-5.1-Highspeed`、`GLM-5`、`GLM-5-Turbo`、`GLM-4.7`、`GLM-4.7-FlashX`、`GLM-4.7-Flash`、`GLM-4.6`、`GLM-4.5-Air`、`GLM-4.5`、`GLM-4.6V`、`GLM-4.6V-Flash`、`GLM-4.6V-FlashX`、`GLM-4.1V-Thinking-FlashX`、`GLM-4.1V-Thinking-Flash`、`GLM-4-FlashX-250414`、`GLM-4-Flash-250414`、`GLM-4V-Flash`、`codegeex-4`、`charglm-4`、`emohaa`。

### moonshot-kimi

- Base URL：`https://api.moonshot.cn/anthropic`；Access：`api-key`。
- 默认启用：`kimi-k3`、`kimi-k2.7-code`、`kimi-k2.6`。
- 默认关闭：`kimi-k2.7-code-highspeed`、`k3`、`k3-256k`。

### minimax

- Base URL：`https://api.minimaxi.com/anthropic`；Access：`api-key`。
- 默认启用：`MiniMax-M3`、`MiniMax-M2.7`、`MiniMax-M2.7-highspeed`。
- 默认关闭：`MiniMax-M2.5`、`MiniMax-M2.5-highspeed`、`MiniMax-M2.1`、`MiniMax-M2.1-highspeed`、`MiniMax-M2`。

### deepseek

- Base URL：`https://api.deepseek.com/anthropic`；Access：`api-key`。
- 默认启用：`deepseek-flash`、`deepseek-v4-pro`。
- 默认关闭：无。

### qwen-alibaba-model-studio-cn

- Base URL：`https://dashscope.aliyuncs.com/apps/anthropic`；Access：`api-key`。
- 默认启用：`qwen3.8-max`、`qwen3.8-flash`。
- 默认关闭：`qwen3.7-max`、`qwen3.7-plus`、`qwen3.7-flash`、`qwen3.6-plus`、`qwen3.6-flash`、`qwen3.5-plus`、`qwen3.5-flash`、`qwen3-max`、`qwen-plus`、`qwen-flash`、`qwen3-vl-plus`。

### qwen-alibaba-model-studio-intl

- Base URL：`https://dashscope-intl.aliyuncs.com/compatible-mode/v1`；Access：`api-key`。
- 默认启用：`qwen3.8-max`、`qwen3.8-flash`。
- 默认关闭：`qwen3.8-omni-flash`、`qwen3.7-max`、`qwen3.7-plus`、`qwen3.7-flash`、`qwen3.6-plus`、`qwen3.6-flash`、`qwen3.5-plus`、`qwen3.5-flash`、`qwen3-max`、`qwen-plus`、`qwen-flash`、`qwen3-vl-plus`。

### xiaomi-mimo

- Base URL：`https://api.xiaomimimo.com/anthropic`；Access：`api-key`。
- 默认启用：`mimo-v2.6-pro`、`mimo-v2.6-flash`、`mimo-v2.5-pro`、`mimo-v2.5`。
- 默认关闭：无。

### xiaomi-mimo-token-plan

- Base URL：`https://token-plan-cn.xiaomimimo.com/anthropic`；Access：`api-key`。
- 默认启用：`mimo-v2.6-pro`、`mimo-v2.6-flash`。
- 默认关闭：无。

### openai

- Base URL：`https://api.openai.com/v1`；Access：`api-key`。
- 默认启用：`gpt-6-astra`、`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`。
- 默认关闭：`gpt-5.6`、`gpt-5.4`、`gpt-5.4-pro`、`gpt-5.4-mini`、`gpt-5.4-nano`、`gpt-5.3-codex`。

### anthropic

- Base URL：`https://api.anthropic.com/v1`；Access：`api-key`。
- 默认启用：`claude-fable-5-1`、`claude-fable-5`、`claude-opus-5`、`claude-sonnet-5`、`claude-haiku-4-5-20251001`。
- 默认关闭：无。

### xai

- Base URL：`https://api.x.ai/v1`；Access：`api-key`。
- 默认启用：`grok-4.6`、`grok-build-0.1`。
- 默认关闭：`grok-4.3`。

### openrouter

- Base URL：`https://openrouter.ai/api`；Access：`api-key`。
- 默认启用：`anthropic/claude-fable-5.1`、`openai/gpt-6-astra`、`openai/gpt-5.6-sol`、`anthropic/claude-opus-5`、`deepseek/deepseek-v4-pro`、`moonshotai/kimi-k3`、`z-ai/glm-5.3`、`qwen/qwen3.8-max`、`minimax/minimax-m3`、`xiaomi/mimo-v2.5-pro`、`x-ai/grok-4.6`。
- 默认关闭：`deepseek/deepseek-v4.1-flash`、`qwen/qwen3.8-max-0902`、`openai/gpt-5.6-terra`、`openai/gpt-5.6-luna`、`openai/gpt-5.6`、`openai/gpt-5.4`、`openai/gpt-5.4-pro`、`openai/gpt-5.4-mini`、`openai/gpt-5.4-nano`、`openai/gpt-5.3-codex`、`anthropic/claude-sonnet-5`、`anthropic/claude-haiku-4.5`、`anthropic/claude-opus-4.8`、`anthropic/claude-opus-4.7`、`anthropic/claude-opus-4.6`、`anthropic/claude-opus-4.5`、`anthropic/claude-sonnet-4.6`、`anthropic/claude-sonnet-4.5`、`deepseek/deepseek-v4-flash`、`moonshotai/kimi-k2.7-code`、`moonshotai/kimi-k2.6`、`moonshotai/kimi-k2.5`、`z-ai/glm-5.3-flash`、`z-ai/glm-5.2`、`z-ai/glm-5.1`、`z-ai/glm-5v-turbo`、`z-ai/glm-5`、`z-ai/glm-5-turbo`、`z-ai/glm-4.7`、`z-ai/glm-4.7-flash`、`z-ai/glm-4.6`、`z-ai/glm-4.6v`、`z-ai/glm-4.5-air`、`z-ai/glm-4.5`、`qwen/qwen3.8-flash`、`qwen/qwen3.7-max`、`qwen/qwen3.7-plus`、`qwen/qwen3.7-flash`、`qwen/qwen3.6-plus`、`qwen/qwen3.6-flash`、`qwen/qwen3.5-plus-20260420`、`qwen/qwen3-vl-plus`、`qwen/qwen3-vl-flash`、`minimax/minimax-m2.7`、`minimax/minimax-m2.5`、`xiaomi/mimo-v2.5`、`x-ai/grok-build-0.1`、`x-ai/grok-4.3`。

### opencode-go-chat

- Base URL：`https://opencode.ai/zen/go/v1`；Access：`api-key`。
- 默认启用：`glm-5.3-flash`、`glm-5.3`、`kimi-k3`、`kimi-k2.7-code`、`deepseek-v4.1-flash`、`deepseek-v4-pro`、`mimo-v2.5`、`mimo-v2.5-pro`。
- 默认关闭：`glm-5.2`、`glm-5.1`、`kimi-k2.6`、`deepseek-v4-flash`、`deepseek-v4-flash-vision-exp`、`hy4-preview`、`hy3`。

### opencode-go-messages

- Base URL：`https://opencode.ai/zen/go/v1`；Access：`api-key`。
- 默认启用：`minimax-m3`、`qwen3.8-max`、`qwen3.8-flash`。
- 默认关闭：`minimax-m2.7`、`minimax-m2.5`、`qwen3.7-max`、`qwen3.7-plus`、`qwen3.6-plus`。

### opencode-go-responses

- Base URL：`https://opencode.ai/zen/go/v1`；Access：`api-key`。
- 默认启用：`gpt-5.6-luna`、`grok-4.6`。
- 默认关闭：无。

### opencode-zen-responses

- Base URL：`https://opencode.ai/zen/v1`；Access：`api-key`。
- 默认启用：`gpt-6-astra`、`gpt-5.6-sol`。
- 默认关闭：`gpt-5.6-terra`、`gpt-5.6-luna`、`gpt-5.5`、`gpt-5.5-pro`、`gpt-5.4`、`gpt-5.4-pro`、`gpt-5.4-mini`、`gpt-5.4-nano`、`gpt-5.3-codex`、`gpt-5.3-codex-spark`、`gpt-5.2`、`gpt-5.1`。

### opencode-zen-messages

- Base URL：`https://opencode.ai/zen/v1`；Access：`api-key`。
- 默认启用：`claude-fable-5-1`、`claude-fable-5`、`qwen3.7-max`、`qwen3.6-plus`、`qwen3.5-plus`。
- 默认关闭：`claude-opus-5`、`claude-sonnet-5`、`claude-haiku-4-5`、`claude-opus-4-8`、`claude-opus-4-7`、`claude-opus-4-6`、`claude-opus-4-5`、`claude-sonnet-4-6`、`claude-sonnet-4-5`、`qwen3.7-plus`。

### opencode-zen-chat

- Base URL：`https://opencode.ai/zen/v1`；Access：`api-key`。
- 默认启用：`kimi-k3`、`minimax-m3`、`deepseek-v4-pro`、`glm-5.2`、`big-pickle`、`mimo-v2.5-free`、`hy3-free`、`ling-3.0-flash-fin-free`、`nemotron-3-ultra-free`、`muse-spark-1.2-contributor-free`。
- 默认关闭：`minimax-m2.7`、`deepseek-v4-flash`、`glm-5.1`、`nemotron-3.5-lightning-free`。

## 相邻固定账号配置

本轮维护主题是普通模板；固定账号 Provider 与其共享 Release 和模型规则，因此统计而不复制账号系统说明。Z.AI / BigModel 各有个人、团队、Start、闲时、加速卡，共 10 个固定 Provider。测试生成器覆盖这五种产品路径涉及的正式端点映射。

## 已知差异和后续项

| 项目               | 已确认事实                                                                                                                                          | 处理边界                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 默认基线简化       | revision 32 已实现百万窗口/128000 最大输出基线、简化匹配及两条规则删除                                                                              | 取舍及兼容边界见[匹配与简化](./configuration.md#匹配与简化)，不再作为待实施事项     |
| 清单漂移           | 旧维护清单部分型号、默认启停与本节不同；如普通 GLM 模板的 GLM-5V-Turbo 当前默认关闭                                                                 | 不按历史星号自动改配置；改启停另提行为 MR                                           |
| 脱离静态成员的规则 | zai-api/bigmodel-api 各有 GLM-5-Turbo 默认关闭规则，但不是当前模板成员；四个个人/团队 Provider 各有 GLM-5.2 与 GLM-5-Turbo 精确规则，超出其静态成员 | 先核对个人同 ID 模型、动态成员与历史用途，不能直接判为孤儿删除                      |
| 历史移除意图       | 旧库存的删除段与当前 MiniMax M2.1/M2 等保留成员存在差异                                                                                             | 重新核实上游入口与产品决定，不在文档 MR 中删除                                      |
| MiMo 双产品入口    | revision 33 已包含 `xiaomi-mimo` 普通 API 与 `xiaomi-mimo-token-plan` 套餐模板；前者启用 V2.6 Pro/Flash 与 V2.5 Pro/V2.5，后者启用 V2.6 Pro/Flash   | 已合入 staging；本轮按代码与测试核验，不等于两个产品的真实 Key 调用或线上采用已验证 |
| 新供应商/云入口    | Gemini、Mistral 无内置模板；Azure/Ark/Bedrock 仍为候选                                                                                              | 现有执行链可直接支持的新增均可推进；需要额外适配的路径暂缓，候选不等于已验证        |
| 官方目录新变化     | OpenAI、Anthropic、Z.AI、xAI、MiMo、OpenCode 有需复核项                                                                                             | 见[研究记录](./research.md)，不是已验证配置变更                                     |
| 线上状态           | 本轮未查询生产/测试控制面或实际安装包                                                                                                               | 不能以源码 revision 33 推断线上也是 33                                              |

## 验证状态

本基线的配置结构、模板成员和规则统计已静态核对；本轮 `pnpm provider:config:check-test` 通过，21 个模板的全部成员、默认启停及两份配置 hash 已与正文逐项对账。历史容量简化的定向单测和 Linux 桌面验证不计入本轮通过结果，也不等于所有供应商当前实测。

同步 revision 33 后，正式配置完整性与 MiMo 双模板测试共 2 文件、17 项通过；指定测试配置重跑完整性测试 1 文件、15 项通过。MiMo 测试包含两环境成员、参数 Map 和旧实例覆盖保留。两份配置及 MiMo 单测/浏览器用例与本基线 staging 完全一致，本次文档 MR 未删除或回退这些内容。

本次未取得 API Key，未执行计费 API 请求，未重跑各供应商完整 Agent、桌面/手机和跨系统验收。新增维护项必须在自己的记录中补齐[验证证据](./validation.md)。

## 重新核对清单

从仓库根执行下面的只读命令，打印当前成员与对应精确规则；同时检查正式/测试派生，不把旧文档当作配置源：

```bash
node --input-type=module - <<'JS'
import { readFile } from 'node:fs/promises';
const release = JSON.parse(await readFile('config/provider/zcode-builtin.json', 'utf8'));
const rules = release.config.modelConfigRules.templateModelRules;
for (const template of release.config.providerConfigRules.templateRules) {
  console.log(template.templateId, template.config.api);
  for (const modelId of template.config.builtinModelIds) {
    console.log(modelId, rules.filter(rule =>
      rule.templateId === template.templateId && rule.modelId === modelId));
  }
}
JS
pnpm provider:config:check-test
```
