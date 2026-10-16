# Todo140：闲时模型列表与视觉／搜索能力更新

状态：已实现，合批验证与 review 完成（2026-09-12）；Built-in revision 25，未发布线上配置。

2026-09-12 实施接线：只修改 Built-in 两个闲时成员表、相应精确启用规则及闲时站点搜索位，revision 24→25；通过真实 Resolver→Registry→闲时专用选择 View 验证默认目录及最终能力，复用既有派发／Ticket 测试，不扩大 UI 交互。

## 已确认范围

同时调整 `account:zai-offpeak-idle-plan` 和 `account:bigmodel-offpeak-idle-plan`：

| 项目               | 目标                                                                               |
| ------------------ | ---------------------------------------------------------------------------------- |
| 内置模型列表       | 只保留 `GLM-5.3`、`GLM-5.3-Flash`，两者默认启用；移除 `GLM-5.2`、`GLM-5-Turbo`     |
| GLM-5.3 视觉       | 不支持图片／视频输入，按普通 API 的真实能力配置，不采用 Coding Plan 的桥接能力声明 |
| GLM-5.3-Flash 视觉 | 保留普通 API 已有的图片／视频／PDF 能力                                            |
| 内置搜索           | 两个模型都关闭 `supportsNativeWebSearch`                                           |

这是能力配置本身的调整，不是增加前端徽标隐藏特例。

## 当前情况与实施方向

- 当前两家闲时 `builtinModelIds` 都是 Flash、5.2、Turbo，并各有对应的 enabled 规则，缺少 5.3。列表与配套规则必须一起收口。
- GLM-5.3 通用规则已关闭图片／视频，Flash 的专用规则开启图片／视频／PDF；优先复用既有规则，不复制整份普通 API 配置，不无意义地新增同值覆盖。
- 闲时站点 `https://zcode.z.ai/api/v1/off-peak/anthropic` 当前同时开启搜索和 MCS；只关闭搜索，保留 MCS。
- 主要修改 `config/provider/zcode-builtin.json`，按实施时的最新基线递增 revision，避免覆盖并行配置更新。同步相关配置 spec 与测试。

## 不改的边界

- 闲时继续使用 `anthropic-messages` 和现有 endpoint，参数映射、MCS、账号鉴权、Ticket 绑定、重试与调度机制不变。
- “普通 API 也开启 MCS”的讨论已撤回，本 Todo 不改普通 API 的 MCS。
- 不改普通 API、个人／团队 Coding Plan、Start Plan 的模型列表或能力；不删除 5.2／Turbo 的全局模型规则，它们仍可能被其他 Provider 使用。
- 不把旧模型 ID 静默映射成新型号，不改历史消息、统计、用户个人配置或正在执行的任务。实施时核对闲时派发是否存在旧型号硬编码／持久选择依赖，有无法按现有规则处理的情况先记录，不借机新增数据迁移。
- 不发布线上配置、不修改真实用户数据。

## 执行与验收

- [x] 先补真实 Built-in 解析测试，覆盖两家闲时的精确模型列表、默认启用状态及新旧型号去留，再修改配置。
- [x] 验证最终解析结果：5.3 无图片／视频；Flash 有图片／视频／PDF；两者无内置搜索且保留 MCS、Anthropic 参数映射、上下文／输出／推理档位规则。
- [x] 回归相邻 Provider：普通 API、Coding Plan、Start 的原配置不受影响，尤其普通 API 的 MCS 和套餐搜索不被连带修改。
- [x] 检查闲时消费链路与测试中的旧型号假设，验证新任务可使用新列表；保持 Ticket、凭据及已绑定执行边界，不只验证 JSON 能解析。
- [x] 合批运行相关配置／派发测试、类型检查、lint 和架构检查；完成后逐项 review 并记录实际验证范围、限制及提交。若发现必须改 UI 交互，再补相应用例，不为了本次配置改动重做 UI。

## 2026-09-12 实施与复审

真实 Built-in→Resolver→Registry→闲时 View 与相邻 MCS 配置测试通过，既有派发／鉴权／重试回归通过；未联网验证线上闲时服务的新模型供给。

合批证据、既有失败分类及多端限制见[本轮复审记录](../research/todos-136-139-140-review-20260912.md)。不把未测范围写成通过；未自动 push。
