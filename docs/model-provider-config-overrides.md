# Model Provider Config Metadata Merge

## 背景

App 侧模型供应商权威源是 `~/.zcode/v2/config.json` 的 `provider` 字段。这个文件可能来自
旧版本迁移、远端同步、用户手动编辑或设置页保存。用户已经显式配置的模型 metadata 必须
保留；本地 catalog 只负责补齐缺失事实。

## 设计

`packages/services/src/model-provider/modelProviderServiceStorage.ts` 在读取
`~/.zcode/v2/config.json` 后，先把 provider 配置转为内部 `ModelProviderConfig`，再执行 catalog
metadata merge。

合并规则统一为 fill-only：

- 用户已配置 `model.limit.context` 时，保留该值，不允许 catalog 的 `contextWindow` 覆盖。
- App 在 catalog merge 前已归一化 context：缺失或非法值使用新增模型一致的 200K 默认值，
  `[1m]` 后缀使用 1M；catalog 不再参与 context 覆盖或补齐。
- 用户已配置 `model.limit.output` 时，保留该值，不允许 catalog 的 `maxOutputTokens` 覆盖。
- 用户未配置输出能力时，catalog 可以补充 `maxOutputTokens`。
- `128K`、`200K` 也可能是用户显式配置；存储格式没有记录数值来源，因此禁止仅凭数值
  猜测它是历史 fallback 并替换。旧版本自动写入的同值配置同样保留，避免迁移误伤用户值。
- 其他 metadata 继续沿用既有保守补缺与迁移规则。
- 缺失 metadata 被补齐后，既有 `writeProviderStoreFile` 持久化流程保持不变。

当前补缺数据源使用仓库根目录的
`models_catalog_china_llm_zcode_2026-06-03.json`。`apps/zcode-cli/api.json` / models-dev
snapshot 不参与 App config 的 catalog merge。

## 配置优先级

```text
context: 用户 provider config > App context normalization（[1m] / 200K 默认值）
output:  用户 provider config > catalog maxOutputTokens > 32K runtime fallback
```

该优先级同时决定正常请求使用的模型级输出预算；只有模型值完全缺失时才 fallback 到 32K。
adapter 不再施加独立全局请求上限，见
[模型请求输出上限策略](./model-request-output-tokens.md)。

## 验证

- config 中已有 `limit.output = 131072`、catalog 为 64000 时，service 返回值和持久化配置都保持 131072。
- config 未提供 `limit.output`、catalog 提供 64000 时，service 可以补齐并按既有流程持久化 64000。
- config 中已有 `limit.context = 128000` 或 `200000`、catalog 为 1000000 时，service 返回值和
  持久化配置都保持用户值。
- config 未提供 `limit.context`、catalog 提供 1000000 时，service 仍按 App 归一化规则持久化
  200000；`[1m]` 模型仍持久化 1000000。
- 不在 catalog 中的自定义模型保持用户原值。
- 旧 `model-providers.json` 迁移路径和非输出字段的补缺语义保持不变。
