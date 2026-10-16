# Provider-visible Content 组装

## 范围

本轮调整已有 ZCode 模型可见表面：首轮非 tool-search 轨迹中的长版 communication、共享 act-don't-rederive、目标分支的 autonomy appendix、Harness 的 MCS 说明，以及 EnterPlanMode 中 research/exploration 的一句措辞；同时固定 request-level user context 和文本附件 reminder 的精确文案与分隔。Agent provider 内容不在范围内。

## 组装约束

- 不修改 ZCode 原有 prompt 字符；原文保存在 `default`。
- 新增内容保存在 `additional`，当前直接加载，不加入模型或 provider 判断。
- communication 位于 action caution 之前。
- communication、action caution 与稳定的 `# Harness` 独立于 output style 的 `keepCodingInstructions`；目标组装只用该字段控制独立的 doing-tasks coding instructions。ZCode 当前没有对应的独立段，因此 `keepCodingInstructions: false` 不应裁掉任何 `# Harness` 内容。
- active output style 严格按 `# Output Style: <name>\n<prompt>` 组装，标题与正文之间不插入空行。
- context management 后依次组装 act-don't-rederive 与四段 autonomy appendix；git context（若存在）继续位于其后。
- EnterPlanMode 的 input schema 保持严格空对象，只将 research/exploration 句改为 `use the Agent tool instead`。
- request-level user context 的末段 `IMPORTANT:` 保留六个前导空格。
- 同一文本附件的合成 Read reminder body 用单换行连接，不同附件在同一个 MCS turn 中仍用双换行连接；live 与 resume 走相同组装规则。

## Exact-word 基线

- communication 使用长版文案，内部复用原有代码风格单句，原句只出现一次。
- act-don't-rederive 是 277 字符，末尾没有句号。
- autonomy appendix 是 1354 字符、四个段落。
- Harness 使用 mid-conversation system turn 文案，不再描述 message/tool result 中的 tag 注入。
- 默认上限截断的文本附件明确写 `first 2000 lines`，并提示按需继续读取该文件。

## 非目标

- 不调整 beta、产品专属内容、deferred tools、Agent provider catalog 或 system block 合并方式。
- 不补充其他动态 section，不增加运行时开关或兜底。

## 验收

- 单元测试校验 exact word、单次出现和相对顺序。
- 单元测试覆盖 active output style 且 `keepCodingInstructions: false`，确认稳定的 `# Harness`、communication 与 action caution 均仍然存在。
- 单元测试校验 output-style 标题与正文之间只有一个换行。
- runtime 测试校验首轮最终 provider-visible request，而非只检查中间 section。
- attachment 与 resume 测试分别校验同附件单换行、不同附件双换行、截断文案及恢复后一致性。
- `prompt-trajectory` 以 mock provider 跑完整 runtime/proxy/derive 链路，并覆盖 MCS、memory、request-level context 与附件；生成轨迹后，按本节范围与 exact-word 基线校验。
