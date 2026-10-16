# Built-in 在线发布链路复核（2026-09-11）

> 性质：代码事实与运行验证；本轮不修改产品代码。实施入口为 [Todo127](../steps/todo-127-builtin-online-release.md)。
>
> 基线：`af5843586b`，Builtin revision 19。新鲜度检查提示本地 staging 落后 origin/staging 5 个提交；已比对本次审查的 Provider、Provider Node、Services 下载入口及 CLI 启动相关实现，与远端无差异。本轮不代替合并最新代码；实施前重新检查。

## 1. 总结

传输与缓存底座有复用价值，但目前不能把“之前写过”或“旧单测通过”当成在线发布已可靠。确认存在新字段未接入、Standalone 更新不生效、App 正文超时失效三项问题；刷新调度和发布验收也需补齐。未发现必须重做 Provider 领域架构或新增持久化 schema 的理由。

## 2. 线上实测

请求 `https://zcode.z.ai/api/v1/client/configs?app_version=3.12.0&platform=linux-x86_64`，HTTP 200、业务 code 0：

```json
{
  "data": {
    "configs": {
      "builtin_provider_config_json": "https://cdn-zcode.z.ai/zcode/config/zcode-builtin.json"
    }
  }
}
```

省略了无关字段。未返回旧的 `configs.zcodeBuiltin`。将真实响应交给当前 `decodeZCodeBuiltinClientConfigEnvelope`，得到 `null`。

CDN 下载 HTTP 200、`Content-Type: application/json`，`schemaVersion: 1`、`revision: 19`；当前正式 `decodeZCodeBuiltinRelease` 成功，17 个模板、8 个内置 Provider，规范化后与仓库文件一致。`Cache-Control: max-age=31104000`，即 360 天。用户确认以后每次发布新 URL，不覆盖同 URL；长缓存本身不是要修的错误。

本次只证明生产环境该版本／平台组合返回正确 URL；测试环境请求失败，未证明其配置。未验证服务端所有版本／平台分流，也未更改线上字段、上传或发布文件。

## 3. 现有链路

```text
App / Server Environment Host                 Standalone CLI 入口
  Services.fetchZCodeBuiltinRemoteRelease       fetchCliZCodeBuiltinRelease
                    \                         /
                 旧 configs.zcodeBuiltin 解码
                              |
                   RemoteSynchronizer
            共享控制文件 lease / TTL / 失败退避
                              |
             Source.applyRemoteRelease + 文件锁
              max revision / 同版本内容一致性
                              |
               原子替换 Active，通知配置变化
                              |
              ConfigService + Account Source
                              |
          Registry（两个来源的 Built-in 版本须一致）
                     /                    \
             设置 / 选模投影            ModelFactory
                                     新建执行使用新配置
```

Host 管理的 Worker 通过环境变量接收同一 Active 文件路径，自己读／监听文件；Account 通过既有协议交付。Standalone 自己获取远端配置并从凭据派生 Account。手机依附目标 Host，不独立下载、存储或组装 Built-in；SSH／WSL／Docker／Server 保持目标 Environment 权威。

## 4. 确认问题与实现缺口

### R1：新字段未接入，生产响应被当成 missing

- `packages/provider-node/src/zcode-builtin-release.ts` 的 Envelope 解码器只取 `zcodeBuiltin`。
- `packages/services/src/model-provider/zcodeBuiltinRemoteConfig.ts` 与 `apps/zcode-cli/packages/cli/src/provider-runtime-env.ts` 都只请求一次 client/configs 后调用该解码器，没有 URL 下载。
- 实测真实生产响应解码为 `null`；Synchronizer 将 missing 当正常结果，写下一次允许刷新时间，不报告网络错误。
- 必修：两端共用新字段解析、下载与 Release 校验。缺字段可保持本地；字段存在但类型错误／URL 非法／下载或解码失败必须与正常缺省区分。

### R2：Standalone 的 Built-in 已变，Account 版本未跟随，Registry 保留旧版

- `apps/zcode-cli/packages/bootstrap/src/app/process-provider-registry-runtime.ts:80` 订阅凭据变化重建 Account，没有对应的 Built-in 变化订阅。
- `packages/provider-node/src/provider-registry-runtime.ts:40` 只在启动时建立未初始化 Account 的 fail-closed 快照。
- `packages/provider/src/registry-service.ts:204` 明确要求 Account 的 `basedOnZCodeBuiltinRevision` 与 Config 一致；不一致时保留上一份完整 Registry。这项一致性检查正确，不应为了更新生效而删掉。
- 运行复现：临时文件装载真实 revision 19，启动 `NodeProviderRegistryRuntime`；只将文件 revision 更新为 20，读取 Config 后显式刷新 Registry。Config 为 20，Account 和 Registry 仍为 19，刷新返回旧快照。测试不依赖定时等待或真实账号，已证明底层停滞；Standalone 生产装配的订阅缺口另由代码确认。
- 同类启动竞态：凭据初始化与后台下载之间发生 Built-in 更新时，启动对齐也需覆盖，不能只测启动后更新。
- 修复方向：Standalone 在同一生命周期中针对 Built-in 和凭据变化串行重建 Account，以真实当前凭据派生；结果过期则重算。无账号时也需生成基于新 Built-in 的 fail-closed 快照。不得把旧 Account 仅改 revision 冒充新解析，不重做登录协议。

### R3：App 请求的超时没有覆盖正文读取

- `packages/services/src/providers/api/nodeApiClient.ts:168` 在 `fetch()` 返回 Response 后清除内部超时；`readApiJson` 随后才执行 `response.json()`。
- 本地 HTTP 服务运行复现：立即发响应头，220ms 后结束 JSON 正文，设 `timeoutMs: 40`；实际约 228ms 后成功读取，而非超时。说明正文阶段失去该超时保护。
- CLI 当前 `AbortSignal.timeout(15000)` 仍关联 Response 正文，不能把 App 与 CLI 的行为混为一谈。
- URL 链路新增第二次请求后，建议在本功能共用下载边界显式持有贯穿响应体消费的取消／超时信号，并限制下载大小。整个拉取预算须与 30s lease 匹配；不要叠加两个完整 15s 再加无限正文读取。
- 不借此自动重构所有 ApiClient 调用；以 Built-in 下载路径的最小修复为先，通用修复另评影响。

### R4：TTL 和退避不是自动调度，成功也不等于 Registry 已应用

- `NodeProviderConfigRuntime.start()` 仅触发一次后台 refresh；设置页经 `useModelProviders → ProviderSettingsService → refreshSources` 触发强制刷新。
- Standalone `prepareCliProviderRuntimeEnv` 也是一次后台刷新，完成即 dispose Source／Synchronizer；不能在该已结束对象上加一个无归属 timer 就声称支持长时间运行。
- `nextEligibleAt` 只约束下一次有人调用 refresh 的时间，不会自行唤醒。失败退避同理；缺字段写入成功 TTL 后当前进程也不会自动重试。
- App `AccountProviderService` 会订阅配置变化并重新解析，正常路径比 Standalone 完整。但若更新后的 Account 重建失败，会保留旧 Account；下一次远端为 unchanged 不会再次发配置变化。因此恢复验证必须覆盖 Account 重新对齐，不能以定时重复下载代替依赖恢复。
- `applyRemoteRelease` 的 updated 仅表示 Active 已提交，不表示所有 Worker／Registry 已观察。手动刷新还可能因另一进程持有 lease 而 skipped。现有 UI 不需要新增状态枚举，但日志／测试不得将这些结果当“全端已生效”。

## 5. 已有机制：可保留，但有明确边界

| 环节 | 复核结果 | 本轮处理 |
| --- | --- | --- |
| Release 校验 | 严格外壳、schemaVersion、非负安全整数 revision；Provider／Model parser 校验；正则合法性和 CEL 编译已在正式 schema 中 | 直接复用，不复制一套 schema |
| 原子持久化 | Active 文件锁内比较，临时文件原子替换；Provider 与 Model 整份替换，无跨源拼装 | 保留，增加 URL 下载后的集成覆盖 |
| 版本比较 | 低版本 stale；同版本同内容 unchanged；同版本不同内容拒绝；启动时同版本缓存冲突回随包 | 保留；内容回滚发更高 revision |
| LKG／随包 | 能解析的候选取较新；损坏、旧 schema、较低版本可回随包；双候选均无效报错 | 不新增空配置或伪成功兜底 |
| 环境隔离 | 平台／App 版本／控制面 Endpoint 分路径，revision 含来源路径身份 | CDN URL 仅是该来源本次传输地址，换 URL 不换缓存身份、不清历史 revision |
| 并发刷新 | 进程内 in-flight 合并，进程间 lease；force 不绕过有效 lease；最终文件锁+revision 防倒退 | 保留。lease 是可过期去重，不是永久排他；增加两阶段慢请求、接管、迟到响应回归 |
| 退出／Endpoint | 已有下载返回后的 disposed／Endpoint 检查和旧源 dispose | 增加下载正文、提交前和定时器生命周期验证；不声称覆盖所有切换时序 |
| 变化投影 | Source→Config→Registry 完整发布；Host Account 变更通过协议通知 Worker；Worker 监听 Active | Linux 下已有单测支持；真实桌面／手机、多进程跨平台仍须验收 |
| Personal／执行 | 在线源属于同一个 Built-in 候选，Personal 优先；已创建 Model 冻结 | 不重写选择、历史或正在运行的模型；后续创建的执行正常解析新配置 |

### 校验能力的限制：不是新发现的“违背设计”

运行复现：从真实 release 删除通用 Model／Model+API／Site 三组规则，保留模板名单和精确启停，使用更高 revision。`decodeZCodeBuiltinRelease` 仍成功，`applyRemoteRelease` 返回 updated 并写盘；解析 GPT-6 后 `validateComplete()` 报 2 项缺失。故**可解析不等于模型可用**，这种内容会替换 Active，而不是自动恢复上一版。

这符合 [Todo19 历史裁决](../steps/todo-19-zcode-builtin-release-integrity-validation.md)：远端同步首版不增加客户端业务完整性校验器，不注入假账号或 API Key 验证整份 Registry。本轮不悄悄恢复被废弃 Todo19，也不按当前 Personal／账号拒绝公共配置。

本次发布必须在上传前对最终文件运行现有真实 Built-in 完整性／规则／请求测试，补本功能所需的两阶段下载验收；不要把测试写死只验证仓库文件而实际上传另一份内容。是否未来增加独立发布工具、全自动流水线或客户端业务门禁仍需另行裁决。配置业务错误不能承诺自动回滚，当前恢复方式是更高 revision 的纠正发布。

## 6. 运行验证与局限

| 证据 | 结果 |
| --- | --- |
| 生产 client/configs → CDN → 正式 decoder → 本地文件规范化比较 | 成功；旧 Envelope 对同一响应返回 null，见 §2 |
| 根 Vitest：Services 下载、Provider Node release／runtime、Services config runtime、Provider Registry Service | 5 文件、46 条通过 |
| CLI `tsx --test packages/cli/tests/provider-runtime-env.test.ts` | 4 条通过 |
| CLI 自己的 Vitest：`packages/bootstrap/tests/process-provider-registry-runtime.test.ts` | 1 文件、10 条通过 |
| 临时 Runtime、HTTP、缺规则 Release 复现 | 分别证明 R2、R3 与业务完整性边界；没有修改正式配置或测试 |

根 Vitest 默认未收集 CLI 两个目标文件；随后拆用正确 runner。一次将 bootstrap 的 Vitest 文件交给 node:test 导致 runner 错误，改用 CLI Vitest 后 10 条通过，不归因产品缺陷。总计 60 条现有测试通过；**它们均非新增 URL 链路验收**。

复现临时脚本路径为 `/tmp/builtin-review-repro.mts`、`/tmp/builtin-timeout-review.mts`；只读代码，在系统临时目录创建测试状态并清理，不触碰用户配置。实施时把上述场景转成仓库持久测试。日志：`/tmp/builtin-online-full-review-tests.log`、`/tmp/builtin-online-cli-entry-review-tests.log`（单独正确 runner，4 条通过）、`/tmp/builtin-online-bootstrap-review-tests.log`；错误混用 runner 的历史日志为 `/tmp/builtin-online-cli-review-tests.log`。

未做实际桌面／手机 E2E、真实跨进程更新、Windows／macOS 文件 watcher、SSH／WSL／Docker／Server 网络验证；未发送付费模型请求，未执行线上发布。不宣称以上已通过。
