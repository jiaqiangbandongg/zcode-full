# Todo97：Selection 存储边界审计

2026-09-08，基于 `dd38abe9fb` 后工作区；2026-09-09 补齐 Wiki 一次落盘迁移。不是“搜索字段名即完成”：按迁移、正式读取、使用、保存、重启逐入口追踪。已裁决开发范围完成；验证债归 Todo102。

## 发布依据与当前格式

| 存储 | 已发布来源 | 当前格式 / 迁移入口 | 正式使用与保存 | 结论、证据 |
| --- | --- | --- | --- | --- |
| 用户 Subagent Markdown | staging serializer 的 `model` / `thoughtLevel`，含 custom URI 编码 | 同字段保留；`migrateUserSubagentMarkdown` 只改用户根目录 Provider 值 | Host/Agent 共用正式 codec；Save 不写中间态 `modelSelection` | 本项实现；共享文本/文件、Host 冷读取、Agent App 初始化测试；Pro SE/I20 通过 |
| 项目/插件 Markdown | 同字段 | 排除自动迁移；普通 reader 不换旧身份 | 显式旧身份保留不可绑定，沿用执行校验；项目主动 Save 仍可用 | 删除全 profile 内存 alias importer；SA97-09 实际调用用户/项目和插件 loader 连续两次，三份同内容 CRLF 文件仅用户文件改变，项目/插件字节与显式旧身份不变 |
| 内置 agents-state.json | staging `builtInModelOverrides` / `builtInThoughtLevelOverrides` | `builtInModelSelectionOverrides`；共享 Node 文件迁移先落盘 | Host 与独立 Agent 的正式 reader 只取新 map；旧值仅作回滚保存 | 原 Host 普通 reader 会反复内存转换，已移到明确导入边界；新 map 的空、坏、缺档位不回读旧值；Pro I20 从旧双 map 冷启动 child/high |
| Session 当前 entry | staging `session-facade.ts` 保存 `runtime/model_selection` 的 providerId/modelId/thoughtLevel；不是臆造中间格式 | providerId/modelId/options；Store 单向迁移 + SQLite CAS | 普通 entry codec 不再搬运 thoughtLevel；恢复先迁移，结果保留原意图，Runtime 最终校验独立 | 本项发现并移走普通 codec 的旧档位回读；真实 SQLite 及 codec 23 测试通过；原 96 App/Protocol 回归继续复跑 |
| Session 历史 message/part | staging user.model、assistant.providerID/modelID/variant、timeline 模型标记 | 历史原字节保留；hydration 投影成当前消息表示 | 不把旧历史投影当作当前选型。只有缺当前 entry 时，明确迁移入口可取确定历史事实生成 entry；新 entry 空/坏阻断回退 | 保留不可变历史展示 decoder，不批量重写消息；它不是运行时当前选择兜底，符合此前“不改历史”约定 |
| Automation SQLite | 旧 model/provider/thought_level 列 | model_selection；Repo ensureReady 离线导入，SQL NULL 与 JSON null 分开 | 正式 row reader 只取新列；派发用目标 getView 结果并冻结 run；任务意图不改 | 96 实现；Pro SR87-06 / SM96 在当前 Team 下旧任务固定迁 Individual，实际派发 Team/high，旧列仍原样 |
| Bot JSON | staging config.ts 明确 `bot-config.json` v2、`bot-state.v2.json`，另有更早 bot-state.json | 现行 v3 文件；只在 v3 缺失时锁内导入旧文件并写 v3 | 当前文件存在即严格解析；坏文件不从旧文件补救；业务不再用旧模型字段恢复 | v2 是已发布来源，不因版本号相近误删；96 Bot 全组验证离线迁移、空新选择、远端失败不借其他 Host 候选 |
| Wiki / Wiki Draft | generationModel + generationOptions.thoughtLevel | modelSelection；`readModelDocument` 锁内复查 → `migrateStoredModelFields` 离线导入并原子落盘 | `readCurrentModelDocument` 只读新字段；空/坏新字段不回读、不迁未上线中间身份；已迁文件不重写 | Todo97 §8 最新裁决取代只读导入例外；保留正文/未知选项，迁移与保存/删除共用文件锁；SA97-W 文件测试及 Pro WIKI-READ/DEL 通过 |
| V4 Composer Draft | 独立 v4 key；早期仅正文 | 当前 key 的 modelSelection + mode | 规范化只读 modelSelection，不从 provider/model/thought 旧属性补值；正文/改选保存草稿，accepted 回写与 Recent 分开 | `composerDraftStore.ts`、`useDraftConfigControl.ts` 已追踪；后者 SessionConfigState 的 provider/model 是同一 effectiveSelection 的展示投影，不是读取旧磁盘字段 |
| Recent / Default | Model Selection 重构后的独立结构化键/配置 | `composerRecent.ts`、现行 preference schema | 不解析旧套餐菜单键、不从坏值查账号修补；Recent 成功接纳写入，不是点击即改 Session | 不虚构未发现的“旧 Recent”格式做兼容；现有测试含空值及同路径不同 workspaceIdentity |
| Personal Provider Config | 旧模型供应商结构，由 legacy reader/importer 明确列举 | Node Provider Config Runtime 在目标文件缺失时导入并落盘 | 新文件存在则严格校验；不能因网络/Schema错误回读旧 Provider 补值 | 保留已裁决的不兼容中间态 enabled/matchRules；用户已有未提交 importer 重命名不混入本轮 |
| Account connection settings | staging family modes/selectedKeys | providerFamilyConnectionSelections；needsMigration 只在新字段不存在时判定 | 正式 AppSettings 不暴露旧键；旧字段仅保留回滚。旧 Team 组织补齐仍需 OAuth，是连接身份迁移，不是 Selection 迁移 | 96 只移除 Selection 对账号的依赖，没有删掉真实连接/OAuth迁移。已有新字段空值不回读旧键 |
| Off-Peak / Ticket | 旧闲时专用任务列及服务端票据 | 既有专用迁移 / schedulable / 固定 ticket | 当前仍有旧 model/thought 列参与失效、重排和专用迁移 | **明确排除通用改造**：只审计，不改 Ticket 归属、不套 Individual 或普通 getView 迁移，沿用用户已裁决例外 |

## 本次删除 / 保留的理由

- 删除 Markdown 中间态双读/写入分支和全 profile 内存 Provider 转换；删除 Host 的旧通用 parser，正式 Markdown codec 与 JSON schema 分开。
- 保留内部/协议结构化 ModelSelection；内置 JSON 的新 map 不是 Markdown 中间态。
- 保留历史消息展示的 hydration 投影与真正旧数据 importer；它们不得重新成为当前选型的备用来源。
- 旧格式是否已发布依据 staging 实际写入点判断：Session thoughtLevel entry、Bot v2 都确实存在；不按字段看起来新旧就批量删除。
- 文件只改用户目录；无全局“迁移完”标记，不遗漏后来加入的旧文件；文件锁、原文比较、权限及符号链接边界由共享 Node 入口承担。普通请求不调用迁移/不偷偷换 Provider。

## 验证与未完成

- Pro `desktop-e2e-20260908172422561-p96860-3f1d8f499a4468d5`：SE-01/02/03 + I20 共4项通过。用户/项目表单产物是原字段；JSON旧双map重启后执行三类child/high，父请求仍max。不是仅用UI回显证明运行结果。
- 文本及文件测试包括模型 `$`/`/`/中文编码往返，BOM/CRLF/注释/正文保留，符号链接/只读排除，并发初始化，写入失败重试，以及写前外部编辑不被覆盖。
- Wiki 剩余开发和二审已完成，手机实机/真实 SSH 等验证债统一由 Todo102 接续，不由 Pro 自动化结果代替。

### 二审纠正

- 发现本轮96 Wiki 和97 JSON importer 对已存在的新字段仍转换旧 builtin ID，超出了“只迁已发布格式”的范围。staging 实际 Wiki 写 generationModel、内置 JSON 写旧双 map；因此增加负向红灯，正式新字段不转换身份，只有旧格式导入转换。既有 Session entry 的同名结构曾实际发布，保留其迁移，不按名字机械全删。
- 上述中间态边界不变；真正旧 Wiki 首次加载落盘已在 2026-09-09 获准并实现，见 Todo97 §8。新增独立文件测试，避免混入用户对既有 service 测试的未提交修改。
