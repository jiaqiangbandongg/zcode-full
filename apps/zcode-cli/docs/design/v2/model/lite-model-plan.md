# Lite Model 级别实施计划

## 背景

ZCode 第一版模型调度只需要两个能力级别：

- `main`：主力模型，处理普通 agent loop、代码修改、复杂推理和默认工具调用。
- `lite`：轻量模型，处理低风险、短上下文、结构化的小任务。

`lite` 必须是可选能力。用户不配置 `lite` 时，所有 lite 请求解析到当前 `main`，保证单模型配置仍然完整可用。

## 目标

1. 在 spec、contracts、config 和 runtime 中统一使用 `lite` 命名。
2. 移除旧 `small` / `small_model` 配置兼容，统一只暴露 `lite`。
3. 建立一个明确的模型解析入口，让业务逻辑只表达请求 role，不直接拼模型字符串。
4. 第一版不做自动任务复杂度分类，只在明确场景使用 `lite`。

## 非目标

- 不做大型 model catalog。
- 不做自动 main/lite 分类器。
- 不新增 `ZCODE_MODEL_LITE` 环境变量。后续如确需环境变量，必须先补充用途、优先级、错误行为和测试覆盖。
- 不把 provider 兼容性分支散落到 core runtime。

## 配置契约

推荐单模型配置：

```json
{
  "provider": {
    "deepseek": {
      "kind": "openai-compatible",
      "name": "DeepSeek",
      "options": {
        "baseURL": "https://api.deepseek.com",
        "apiKey": "sk-..."
      },
      "models": {
        "deepseek-v4-pro": {}
      }
    }
  },
  "model": "deepseek/deepseek-v4-pro"
}
```

需要区分 `main` 和 `lite` 时：

```json
{
  "provider": {
    "deepseek": {
      "kind": "openai-compatible",
      "options": {
        "baseURL": "https://api.deepseek.com",
        "apiKey": "sk-..."
      },
      "models": {
        "deepseek-v4-pro": {},
        "deepseek-chat": {}
      }
    }
  },
  "model": {
    "main": "deepseek/deepseek-v4-pro",
    "lite": "deepseek/deepseek-chat"
  }
}
```

解析规则：

1. `model` 字符串等价于 `model.main`；值必须是 `provider/model`。
2. `model.main` / `model.lite` 只接受 `provider/model` 字符串，不接受 inline target。
3. `model.lite` 可选；如果缺失，则 `lite` role 解析为当前 `main`。
4. `small_model` 和 `model.small` 不再作为兼容输入，schema 必须拒绝。
5. 如果 `model.lite` 指向不存在的 provider/model，错误归属为 `provider_not_configured` 或 `model_not_found`，不能静默回退到 main。
6. `apiKey` 和 `headers` 属于 provider 连接配置，优先从 `provider.*.options` 读取；未配置 `apiKey` 时 adapter 可以从环境变量 fallback，但不暴露 `apiKeyEnv` 用户字段。

## Role 解析契约

新增统一解析入口：

```typescript
type ModelRequestRole = "main" | "lite" | "compact" | "review" | "subagent";

interface ModelRoleResolver {
  resolve(role: ModelRequestRole, context: ModelRoleContext): ModelRef;
}
```

默认映射：

| Role | 默认模型 |
|------|----------|
| `main` | `model.main` |
| `lite` | `model.lite ?? model.main` |
| `compact` | `model.main` |
| `review` | `model.main` |
| `subagent` | parent model |

后续可以在 role policy 中把 `compact` 或特定 subagent 指向 `lite`，但第一版不自动改变。

## 第一批 lite 使用场景

只在明确低风险场景接入：

- 本地 TUI session title 生成；如果用户没有配置 `model.lite`，该请求必须解析到当前默认/main 模型，但 `modelRef.role` 仍记录为 `lite`。ZCode app-server 和 headless 默认不启用标题生成。
- tool batch 短摘要。
- hook prompt 的结构化判断。
- away summary / idle summary。
- 简单权限说明或只读分类器。

不用于：

- 需要跨文件修改的主 agent loop。
- destructive tool 决策。
- compact 正文总结，除非后续 spec 明确放开。
- review 或安全判断的最终结论。

## 实现顺序

1. Spec 已更新：`docs/design/v2/model/README.md` 和 loop interface 草案使用 `lite`。
2. Contracts：
   - `ModelRole.Small` 改为 `ModelRole.Lite`。
   - `RuntimeConfig.model` 由 provider-first config 解析成 `{ main, lite? }`。
   - 用户配置不保留 `RuntimeConfig.model.small` 兼容入口。
   - 用户配置不保留 inline target 兼容入口。
3. Config adapter：
   - file config 读取 `model.lite`。
   - 拒绝 `model.small`、`small_model` 和 inline target。
   - 不新增 lite 环境变量。
4. Bootstrap/runtime：
   - 引入 `ModelRoleResolver` 或等价 helper。
   - runtime 不再直接持有单一 `defaultModelRef` 作为所有请求的唯一来源。
   - 普通请求使用 `role: "main"`。
   - 明确低风险边车任务使用 `role: "lite"`。
5. Events/logging：
   - `model.request` 和网络状态事件记录最终 `ModelRef`。
   - 需要额外记录 `requestedRole`，用于解释为什么一次请求走了 `lite` 或继承了 `main`。
6. Tests：
   - 先补 contracts/config/resolver 单元测试。
   - 再接 runtime 场景测试。

## 测试要求

必须覆盖：

- 未配置 `model.lite` 时，`lite` 解析为 `main`。
- 配置 `model.lite` 时，lite 场景使用 lite，main 场景仍使用 main。
- schema 拒绝 `small_model`、`model.small` 和 inline target。
- lite provider 未配置时返回结构化错误，不静默回退。
- session/model event 中包含最终 `ModelRef` 和请求 role。
- subagent 默认继承 parent，不因 lite 存在而自动降级。

验证命令：

```text
npm run lint
npm test
```

## 验收标准

- 单模型用户无需新增配置即可继续工作。
- 双模型用户只需配置 `model.lite`，即可让明确边车任务使用轻量模型。
- core 业务逻辑不直接读取 config key 或环境变量，只通过 role resolver 获取模型。
- `small` / `small_model` 不再作为用户配置、事件或公开 API 输入。
