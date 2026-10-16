# Bugfix 09：Kimi 多模态能力证据校正

> 状态：已完成
>
> 日期：2026-09-01

## 问题

Built-in Config 把下列模型能力写错：

| Model            | 当前值                   | 当前官方事实                                              | 目标值       |
| ---------------- | ------------------------ | --------------------------------------------------------- | ------------ |
| `kimi-k3`        | Image=false、Video=false | Kimi API 与 K3 发布资料明确为原生视觉，支持图像和视频理解 | true / true  |
| `kimi-k2.7-code` | Image=false、Video=false | Kimi 官方 FAQ 明确支持 Text、Image、Video                 | true / true  |
| `k3-256k`        | Image=true、Video=true   | Kimi Code 模型表明确为 Image only                         | true / false |

`packages/provider-node/test/zcode-builtin-integrity.test.ts` 又断言了前两个错误值，使错误配置能够稳定通过测试。

## 根因

2026-08-28 的 Built-in 资料刷新只在研究摘要中记录了 K3 的上下文长度，没有记录多模态能力。实现时把
“本次资料没有记录”错误地解释为“模型不支持”，将原有的正值降成了 `false`。这不是 Resolver、Overlay 或
Adapter 的问题，而是发布证据到 Config 的人工投影规则不完整。

## 修复

1. 先修改完整性测试，固定三项官方事实并证明旧 Config 失败。
2. 校正对应 Model Match Rules，不增加 Provider/Model 特化代码。
3. Built-in revision 递增，确保运行中的 Config Source 可以观察到新发布事实。
4. 在 Built-in 维护设计中加入能力降级门禁：资料缺席不能推翻已经发布的正能力。
5. 在发布证据报告中记录本次修订和当前官方来源。

## 影响面

```text
Built-in Model Match Rules
            |
            v
Effective Model Config
            |
            v
Provider Registry / Active Model.properties
        |                    |
        v                    v
设置页与模型选择器       Runtime 输入检查 / Adapter 编码
```

- 不新增 capability DTO，不按 Model ID 在 Runtime 推断能力。
- 已创建的 Active Model 继续冻结；Config 刷新后新创建的 Model 使用新事实。
- Desktop continuous、Web Remote replayable、Session Selection 和队列语义不变。
- Video 仍同时受 `input_format.support_video` 与 Adapter 实际编码能力约束。

## 验证

- 真实 Built-in Config 解析：K3、K2.7 Code、K3-256K 三项媒体能力。
- `@zcode/provider-node` 定向单测与 typecheck。
- 根 `pnpm typecheck`、`pnpm lint`。
- 配置与文档格式检查、`git diff --check`。
