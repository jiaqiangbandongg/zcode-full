# Settings Sync Provider Import

`settings-sync` 在导入 `providers` 分类时，会同时写入两条链路：

1. 运行时配置镜像
2. 设置页 `模型供应商` 的数据源 `~/.zcode/v2/model-providers.json`

## 导入策略

- 只导入缺失项，不覆盖已有 provider
- 运行时配置仍按 agent 原生格式落到各自 workspace config 目录
- 设置页可见的 provider 只导入“当前可识别的自定义 provider”

## 当前映射范围

### Claude Code

- 从 `settings.json` 读取：
  - `env.ANTHROPIC_BASE_URL`
  - `env.ANTHROPIC_AUTH_TOKEN` / `env.ANTHROPIC_API_KEY`
  - `model`
  - Claude 槽位映射相关 env
- 若缺少自定义 endpoint 或 apiKey，则不会生成设置页 provider

### Codex

- 从 `config.toml` 读取当前 `model_provider`
- 只导入当前选中的 provider table
- 从 `auth.json` 读取 `OPENAI_API_KEY`

### OpenCode

- 从 `opencode.json` 的当前 `model` 反推 provider key
- 只导入当前选中的 provider
- 从 provider `options.baseURL` / `options.apiKey` 和 `models` 生成设置页 provider

## 去重规则

以下任一命中即视为已存在：

- provider id 相同
- endpoint / apiKey / models / mapping / supportedFormats 的核心配置完全相同

这样可以避免重复导入，也避免覆盖用户已经在设置页手动调整过的 provider。
