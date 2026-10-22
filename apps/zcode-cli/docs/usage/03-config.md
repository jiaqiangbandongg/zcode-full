# 03 · 配置

## 两类配置文件

当前源码把模型配置和运行配置分开管理：

```text
个人 provider、模型选择 → ~/.zcode/v2/provider_config.json
运行、权限、MCP、Hook、插件 → ~/.zcode/cli/config.json
项目运行设置 → <project>/zcode.json、<project>/.zcode/config.json
账号登录凭据 → 凭据存储，不作为普通模型配置公开
```

`ZCODE_DATA_BASE_DIR` 改变 provider/凭据等数据基目录。个人模型文件可显式用 `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` 指定。不同构建的路径和兼容入口可能不同，先核对本次 CLI 的行为。

运行配置一般按内置默认、用户、项目、环境变量及入口参数叠加。同名 MCP server 的用户配置具有更高优先级；项目 Hook 还必须通过独立的工作区信任。不能用一条“后写覆盖前写”规则概括所有字段。

## 个人模型配置示例

以下是当前文件格式。它用于自定义 OpenAI Chat Completions 兼容服务，地址、模型名和 Key 必须替换。`api.baseUrl` 的拼写与旧格式的 `options.baseURL` 不同。

```json
{
  "schemaVersion": 1,
  "config": {
    "providerConfigRules": {
      "providerRules": [
        {
          "providerId": "example",
          "providerName": "Example API",
          "config": {
            "group": "standard-personal",
            "access": { "type": "api-key", "apiKey": "REPLACE_WITH_API_KEY" },
            "api": {
              "type": "openai-chat-completions",
              "baseUrl": "https://api.example.com/v1"
            },
            "personalModelIds": ["example-model"]
          }
        }
      ]
    },
    "modelConfigRules": {
      "providerModelRules": [],
      "manualProviderModelRules": []
    },
    "defaultModelSelection": {
      "providerId": "example",
      "modelId": "example-model"
    }
  }
}
```

支持的 API 类型为 `openai-chat-completions`、`openai-responses`、`anthropic-messages`。服务必须支持所选协议及任务需要的工具调用。模型能力、推理选项和输出限制还受模型规则约束；不要仅改一个模型名称就假设所有选项兼容。

自定义 API Key 可以由启动器从受控凭据来源写入临时配置。该文件含明文 Key，应限制文件权限，不提交到 Git，不放入评测结果归档。配置读取不承诺对 `apiKey` 字符串做 `${ENV}` 替换。

`providerModelRules` 用于模型规则覆盖；`manualProviderModelRules` 用于完整手动模型定义，同一 provider/model 不能同时出现在两者。精确 schema 见 [provider 文件编解码](../../../../packages/provider-node/src/provider-config-file-codec.ts)及[模型规则](../../../../packages/provider/src/config/rule-data-schema.ts)。默认模型选择的 `options` 可保存模型支持的选项，不能填写该模型不支持的 reasoning 档位。

## 从旧配置迁移

旧构建使用 `~/.zcode/cli/config.json` 中的 `model` 和 `provider`。当前 standalone CLI 在个人模型文件不存在时尝试一次性导入旧用户配置；它不是每次启动都重新覆盖个人文件。

```text
个人模型文件不存在 → 尝试导入旧用户配置 → 保存个人配置
个人模型文件已存在 → 读取个人配置 → 后续修改个人配置
```

因此，迁移后继续改旧文件中的 `model`/`provider`，不能作为可靠的切换方式。项目级旧 provider、旧 `ZCODE_MODEL`/`ZCODE_API_KEY` 环境变量也不能当成新格式的通用覆盖入口。`ZCODE_BASE_URL` 在当前代码中还与产品服务端点有关，不能把模型 API 地址填进去代替 `api.baseUrl`。

旧模型配置可能包含无法迁移的字段；发现错误时先保留原文件并查看诊断，不要删除个人配置来反复强制导入。

## 运行配置示例

```json
{
  "features": { "mcp": false, "subagent": false, "memory": false, "skill": false },
  "memory": { "use": false },
  "plugins": { "enabled": false },
  "skills": { "enabled": false },
  "hooks": { "enabled": false },
  "ui": { "locale": "zh-CN" },
  "modelStream": { "idleTimeoutMs": 600000 }
}
```

这是减少扩展干扰的评测配置，不是通用功能默认值。需要 MCP、技能或插件的任务应显式开启并记录配置。JSON 不支持注释。错误字段可能导致整份配置失效或部分配置被跳过，不能把“进程启动成功”当作配置生效证明。

## 环境变量与网络

常用运行变量包括 `ZCODE_STORAGE_DIR`、`ZCODE_SESSION_DB_PATH`、`ZCODE_LOG_DIR`、`ZCODE_LOG_CONSOLE=1`、`ZCODE_HTTP_PROXY`、`ZCODE_NO_PROXY`、`ZCODE_AGENT_CA_CERT` 和 `ZCODE_MAX_TOOL_CONCURRENCY`。`ZCODE_LOG_LEVEL` 不是受支持的日志级别设置。

CLI 会从有效工作目录向上查找 `.env`，既有环境变量不被覆盖。评测工作区及其父目录不要遗留意外的 `.env`。使用 `network.httpProxy` 或 `ZCODE_HTTP_PROXY` 配置 CLI 网络；不要假设调用者的所有标准代理、证书或 telemetry 变量会原样进入运行时。

完整隔离需要同时考虑用户目录、数据基目录、工作目录和已有环境变量，见[批量任务](13-automation.md)。
