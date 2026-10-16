# 3.9.0 模型模态设置实施计划

> 本计划以 `docs/superpowers/specs/2026-08-21-model-provider-modality-settings-design.md` 为产品边界。交互语义已经确认，可以按测试先行进入实现。

## 变更分类

- `presentation`：取消高级折叠，全部字段平铺；新增输入类型选择和固定 Text 输出展示，Audio/PDF 暂不展示。
- `draft-default`：新增模型默认 context=1M、maxOutput=128K、input/output=Text；旧模型回显输入事实并保留 unknown 来源。
- `validation`：ID 必填、数字字段为正整数、input Text 必选且不可取消、output 固定 Text。
- `commit-effect`：模态与显式来源原子写入 provider model config。
- `persistence`：OpenCode config 的 `modalities` + `zcode` 来源标记 round-trip。
- `recovery`：不新增恢复状态；仅验证 provider registry 热更新与远端显式同步。

## 影响分级

| 级别           | 关系                                             | 原因                                                 | 主要证据                                            |
| -------------- | ------------------------------------------------ | ---------------------------------------------------- | --------------------------------------------------- |
| must-inspect   | `ProviderModelMetadataDialog` / draft helpers    | 直接新增交互、默认和提交字段                         | `packages/ui/src/settings/model-provider-section/*` |
| must-inspect   | shared model provider type/schema                | modalities 已存在，但缺少显式来源语义                | `packages/shared/src/model-provider-types.ts`       |
| must-inspect   | provider storage                                 | 所有模型都会写 modalities，当前无法由数组判断来源    | `modelProviderServiceStorage.ts`                    |
| must-inspect   | provider -> ZCode protocol projection            | custom legacy unknown 与 explicit false 的分界在这里 | `packages/shared/src/zcode-protocol/index.ts`       |
| must-inspect   | active session registry refresh                  | 保存后要无需切模型即生效                             | bootstrap provider registry tests                   |
| conditional    | desktop-attached remote sync                     | 远端 runtime 依赖本地 provider snapshot              | `remoteWorkspaceProviderSync.ts` 与架构文档         |
| should-inspect | chat/automation/Subagent/Repo Wiki model options | 共用 registry，但 commit sink 必须保持隔离           | feature graph model surfaces                        |
| invariant-only | mobile replayable / task snapshot / queue        | 不应携带或恢复模态设置                               | web remote architecture constraints                 |

## 实施切片

### 1. 先更新 spec 与测试目录

- 已完成：更新 `2026-06-04-model-provider-model-editor-design.md`，将平铺字段、默认值和模态规则列入当前模型编辑器 spec。
- 更新 feature graph 的 provider settings / model capabilities 关系和新 code seed。
- 在桌面本地 provider P0 case catalog 增加稳定 case ID；标出远端集成覆盖与不做 mobile E2E 的不变量理由。

### 2. Shared schema 与持久化：先写失败测试

测试先覆盖：

- `ModelProviderModelConfig` 能表达显式来源，但旧对象不要求该字段。
- `createModelProviderModelConfig` 保留/归一化 input/output 和来源。
- OpenCode config 写入 `modalities`，来源写入 `model.zcode`。
- 读写 round-trip 不丢来源；旧配置缺少来源时保持 `undefined`。
- 只修改 context/max token 不会把 legacy text-only 升级成 explicit false。

实现文件：

- `packages/shared/src/model-provider-types.ts`
- `packages/services/src/model-provider/modelProviderServiceStorage.ts`
- 对应 shared/services tests

### 3. UI 草稿与选择器：先写失败测试

测试先覆盖：

- add draft 默认值、edit draft 回显、固定排序和去重。
- context=1M、maxOutput=128K 默认值，input Text 锁定和 output Text 固定规则。
- 模态变更后 `modalitiesTouched=true`；编辑其他字段不触碰来源。
- 取消不提交；保存一次性提交完整 model draft。
- 所有字段平铺、Text/Image/Video 三个输入类型选项直接可见且可换行、小屏弹窗可滚动、键盘可操作、中英文文案完整。

实现建议：

- 扩展 `ProviderModelMetadata.ts` 的 draft 和 commit resolver。
- 新建局部共享组件 `ProviderModelInputModalityOptions.tsx`，以平铺 checkbox/pill 复用现有设计 token，并锁定 Text；不使用 Popover。
- 从 `ProviderModelMetadataDialog.tsx` 删除 Collapsible，把 max output、input modalities、固定 Text output 全部平铺。
- 更新 `ProviderCardSections.tsx`、`ProviderFormControls.tsx` 的 add/edit 草稿接线。
- 更新 `en-US.ts`、`zh-CN.ts`。

### 4. 能力投影闭环：先写失败测试

测试矩阵：

| 来源                  | input          | 期望协议能力                                |
| --------------------- | -------------- | ------------------------------------------- |
| legacy custom，未显式 | `[text]`       | image/pdf 都省略，保持 unknown              |
| custom，显式          | `[text]`       | `supportsImages=false`, `supportsPdf=false` |
| custom，显式          | `[text,image]` | `supportsImages=true`, `supportsPdf=false`  |
| custom，显式          | `[text,pdf]`   | `supportsImages=false`, `supportsPdf=true`  |
| catalog-backed        | 现有事实       | 保持当前权威投影                            |

实现聚焦 `shouldProjectProtocolMediaCapabilities` 的来源判断，不把 `modified` 当能力来源，不扩展 audio/video protocol。

补充 active-session 测试：provider registry revision 更新命中当前模型时，`modelInputMediaCapabilities` 热更新；切到 text-only 后后续 provider-visible request 媒体被文本化，真实 session history 不变。

### 5. 远端与多端边界验证

- local desktop：保存后本地 runtime 使用新 revision。
- SSH/WSL/Docker desktop-attached：本地权威 snapshot 按 `workspaceKey` 与 `remoteSessionId` 下发，远端不读取/写入自己的 provider config 作为权威。
- Web/mobile：设置 UI 若可达则保持响应式；task continuous/replayable、snapshot、queue、owner/lease 没有字段或行为变化。
- Windows/macOS/Linux：不引入平台 API，仅验证通用 Popover/Dialog 交互。

### 6. E2E 与最终质量门

桌面 E2E 复用真实模型 provider 设置链路，至少覆盖：

1. 新增 custom model，验证 1M/128K/Text 默认值，选择 Image/Video，保存后配置 round-trip。
2. 编辑同一模型取消 Image，保存后 revision 变化且 provider request 不再包含 image block。
3. 关闭弹窗不保存。
4. 重启应用后回显一致。

实现完成后按顺序执行：

```text
focused unit tests
        |
        v
provider settings desktop E2E
        |
        v
remote provider sync integration/E2E
        |
        v
pnpm typecheck
        |
        v
pnpm lint
```

## Candidate Cases 与剪枝

| ID          | 场景                                                        | 状态     | 处理                                                  |
| ----------- | ----------------------------------------------------------- | -------- | ----------------------------------------------------- |
| MOD-SET-001 | 新增模型默认 1M context、128K max output、Text input/output | accepted | UI + draft unit                                       |
| MOD-SET-002 | 编辑显式 image/video 并保存，旧 audio/pdf 隐藏值不丢失      | accepted | UI + storage + protocol                               |
| MOD-SET-003 | legacy custom 只改 context                                  | accepted | 必须保持 unknown                                      |
| MOD-SET-004 | 当前 session 接收负向能力热更新                             | accepted | bootstrap/runtime integration                         |
| MOD-SET-005 | desktop-attached remote 同步                                | accepted | remote integration                                    |
| MOD-SET-006 | audio/video input 立即进入请求                              | pruned   | Video 只保存事实，Audio 暂不展示；协议/runtime 未支持 |
| MOD-SET-007 | 非 Text 输出选项与渲染                                      | pruned   | 输出固定 Text                                         |
| MOD-SET-008 | mobile replayable 恢复模态设置                              | pruned   | app-global registry 事实，不属于 task snapshot        |
| MOD-SET-009 | pure non-text Agent 模型                                    | pruned   | input/output Text 固定存在                            |

## 风险与回滚

- 最大风险是把 legacy unknown 误收窄成 false；必须用 absence-of-source 测试锁定。
- 第二风险是用户编辑内置模型后阻断远端权威更新；只读边界与 `modified` 合并规则必须保持。
- 第三风险是 UI 暗示 audio/video 已可用于 Agent；必须用范围文案或缩小选项解决。
- 回滚 UI 时可以停止写入显式来源；已保存来源字段必须向后兼容并可被旧版本忽略，不能删除用户 modalities。

## 实施完成定义

- 产品边界已确认并写入 spec。
- 单元、集成、桌面 E2E 和远端同步证据齐全。
- `pnpm typecheck`、`pnpm lint` 通过。
- feature graph 与测试 case catalog 已更新。
- 提交遵循 Conventional Commits，不使用 `--no-verify`。
