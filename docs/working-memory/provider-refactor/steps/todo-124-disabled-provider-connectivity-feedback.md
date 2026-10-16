# Todo124：禁用 Provider 的连接测试入口与失败提示

> 状态：2026-09-11 实现、局部 review、单测及共享浏览器验证通过；整批最终验收与推送待执行，真实多端联调未测。

## 问题

禁用 Provider 后，设置页仍保留配置和模型列表，但 Resolver 不再向执行 Registry 发布该 Provider。模型行测试按钮只判断正在测试、模型 ID 是否为空及回调是否存在，没有判断 Provider 启停状态。点击后连接测试走正式 Model 创建链路，Registry 返回 `provider-not-found`，用户看到“供应商不存在”，容易误以为配置已丢失。

## 小范围改动

1. 连接测试能确认供应商当前不可执行时，提示“该供应商当前不可用，无法测试连接”，不再把禁用等状态解释为配置不存在。模型自身不可用时使用“该模型当前不可用，无法测试连接”。兼顾中英文。
2. Provider 禁用时，模型行测试按钮置灰，可提示“请先启用供应商”。不改变 Provider 配置和模型行其他操作。

```text
设置页读取 Provider enabled → 禁用时测试按钮置灰
                                     |
测试调用到达（例如点击后状态变化）    |
                ↓                    |
既有公共执行资格 / 正式执行链校验 ←--+
                ↓
可用 → 正常测试；不可用 → 清晰提示，不临时启用或替换模型
```

## 实现边界

实施契约：在已有 waitForProviderOperations 之后读取当前 Settings Facade 的资格事实。先判 Provider 是否存在/启用，再判目标模型自身 disabled/配置问题，再判断公共 executable；不重查 Key/权益。已确认资格失败返回 ModelConnectivityResult.error 可选 code（provider-unavailable / model-unavailable）和默认消息，UI 据 code 本地化，其他错误消息原样保留。该结果属于现有 App 设置服务，Agent 执行协议不变；检查后目标环境继续保留最终正式校验。

- 复用既有公共配置／执行资格结果，不在 UI 或测试服务重写 Key、权益、模型配置校验规则，不新增状态缓存或同步等待机制。
- 在连接测试边界处理提示；不全局替换 Registry 的 `provider-not-found`，不修改其他业务错误契约。
- 不将网络失败、鉴权失败、签名失败等所有测试失败统一改成“不可用”；保留真实错误信息。不能确认是资格问题时，也不能随意改写错误原因。
- 不改变 Registry 发布规则、ModelFactory 最终校验或连接测试复用正式请求链路的原则，不偷偷启用 Provider，不绕过配置、不切换模型、不清空保存的选择。
- 单独禁用模型的类似问题实施时顺带核查；不得因此扩展为重做所有测试按钮状态或整个错误系统。
- 桌面和手机共享设置入口保持一致；不改布局和原有远控传输边界。

## 实施与验收

- [ ] 先更新相关设置／连接测试 spec，补有区分力的测试，再修改代码。
- [ ] 禁用 Provider 后测试按钮不可触发；重新启用后按现有条件恢复，不改模型各自启停状态。
- [ ] 直接调用测试入口或点击后 Provider 被禁用时，给出供应商不可用提示，不产生绕过禁用的模型请求。
- [ ] 模型自身不可用的错误与 Provider 不可用能区分；正常测试、网络／鉴权／签名等错误信息不受影响。
- [ ] 设置页交互 E2E 覆盖禁用、重新启用与提示，兼顾共享桌面／手机及国际化；未完成的环境验证如实记录。
- [ ] 合批运行相关单测、类型检查和 lint，review 公共判断复用、错误分类和无配置副作用后再关闭 Todo。

## 代码入口

### 本轮实施与复审

- Provider enabled 由卡片沿现有列表传到测试按钮，禁用只影响测试按钮；恢复启用仍保留模型自身状态与配置。
- 服务在已有操作队列完成后读取 Settings Facade 的当前公共事实，资格不符不调用正式测试；已知 Provider/Model 资格错误返回局部稳定 code 供 UI 中英文呈现。没有复制 Key/权益检查，没有全局改 Registry 错误或追加状态等待。
- 后续正式请求失败原样返回，仍保留目标 Environment 最终校验；不能承诺一次读取后配置永不变化，也不借此等待跨进程强一致。
- 4 个服务失败用例先红；与119等合跑74项通过，补充缺 Provider/Model 和上游签名错误不改写后，服务10项通过（包含前批重合）。4项共享浏览器用例通过，禁用/重新启用、中英文/两主题/手机与桌面尺寸已测。
- 根 typecheck/lint、架构通过；逐项 review 未产生模型请求旁路、自动启用、选择改写或远控协议变化。真实 Host/手机 shared-host 联调未测；最终批次仍做交付复审。

- `packages/ui/src/settings/model-provider-section/ProviderFormControls.tsx`：模型行测试按钮条件。
- `packages/ui/src/settings/model-provider-section/InlineEditableProviderCard.tsx`、`ProviderCardSections.tsx`：Provider 状态与测试回调传递。
- `packages/services/src/model-provider/providerFacadeServices.ts`、`providerSettingsConnectivity.ts`：连接测试服务入口及错误返回。
- `apps/zcode-cli/packages/bootstrap/src/app/session-facade.ts`：辅助档位补齐及正式连接测试入口。
- `packages/provider/src/resolver.ts`、`registry.ts`：现有执行资格与校验事实，原则上不改。
