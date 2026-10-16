# 文件 Mention 稳定性与 Host 搜索

> 2026-09-16：Composer `@` 通过 Host 查询文件候选，不再下载完整文件索引。

## 范围与契约

- 只迁移 `@` 文件候选的查询与索引归属；文件树、命令中心继续使用原分块列表接口。
- 复用当前 `.zcodeignore`、目录过滤、隐藏文件、软链接规则及既有 fuzzy 匹配/排序。纯匹配算法放在 shared，UI 旧入口继续复用同一算法。
- 新增 `IFileService.searchWorkspaceFiles({ rootPath, workspaceIdentity?, query, limit?, refresh? })`，返回 `WorkspaceFileEntry[]`。默认/最大 1000 条，空 query 仍按现有文件优先顺序，Composer 保持已有预览数量。
- 该接口只通过现有 file RPC；不改公共 RPC、attachment、Agent 协议或 continuous/replayable 恢复语义。

## 状态、缓存与时序

```text
Renderer（关键词、当前查询结果、错误态）
    -> file.searchWorkspaceFiles(query, limit, workspaceIdentity)
    -> workspace 所在 Host（文件扫描/索引的唯一 owner）
       -> .zcodeignore + 60s 索引缓存 + 有界候选匹配
    <- 至多 limit 条候选

query / workspace / service / enabled 改变
    -> 旧查询结果失效 -> 仅最新查询可更新面板

loaded + 非空 query 无命中
    -> 本次 query 最多一次 refresh:true -> Host 绕过缓存重新扫描
error -> 停止自动请求 -> 关闭再打开/切换 workspace 或 service 才可恢复
```

- 缓存归属 file service 实例，按 `workspaceIdentity?.trim() || rootPath` 隔离，并校验 rootPath 与 `.zcodeignore` 指纹。索引短 TTL 60s 与既有 Host 策略一致；同一 key 的扫描去重；缓存有数量上限，移除过期条目。
- 规则修改后下次查询即按新规则执行；refresh 不能被旧缓存吞掉，旧扫描完成不能覆盖后发扫描。
- 关闭面板清理 Renderer 查询/错误状态；重新打开请求 Host。UI 不再持有完整候选数组或文件搜索 Worker。
- Host 分批执行候选构建和匹配，批次间让出事件循环；查询结果受数量上限约束，输入不承担全量索引的传输/解码。
- 本地和远程均使用当前 workspace 对应的 file service；同路径不同 identity、不同 service 不共享缓存或在途查询。手机复用同一 hook 与 RPC，不另建 Host。

## 影响简报

| 项目              | 结论                                                                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 能力/层级         | Composer 文件引用；option-source、缓存 owner 迁移                                                                                      |
| UI Surface Matrix | 桌面/手机 Composer `@` -> MentionPlugin -> useFileMentionProvider -> file service；输入/展示归 UI，索引归 Host，选中后的 Markdown 不变 |
| 共享与差异        | `.zcodeignore` 和匹配算法共享；文件树/命令中心保留全量 packed+Worker 数据路径                                                          |
| must-inspect      | file service 接口、索引 owner、provider 最新结果/错误态、跨 workspace 隔离                                                             |
| invariant-only    | RPC 协议、其余 mention 分组、文件树/命令中心、桌面 continuous/手机 replayable                                                          |
| 状态与提交        | Host 内存索引；UI 有界结果；选中后的 canonical mention 及发送行为不变，无新增持久化                                                    |
| Codegraph         | useFileMentionProvider -> MentionPlugin -> LexicalChatInput（深度 2）；服务列表接口代码以快进后的磁盘为准，索引正在重建                |
| 图谱漂移/更新     | 现有 @ surface 缺少文件索引 owner；补充 Host 搜索 service 节点及 options-from 关系                                                     |
| 未决问题          | 无；本会话已确认仅调整 @ 搜索，公共 RPC 不变                                                                                           |

## 验收与测试计划

| 用例  | 设置与操作                                            | 断言/证据                                                             |
| ----- | ----------------------------------------------------- | --------------------------------------------------------------------- |
| MFH01 | 大工作区打开 @、搜索、选择；桌面宽度和手机宽度        | 搜索接口返回有界结果，不调用 length/range；文件可选且输入响应；UI E2E |
| MFH02 | 同一索引查询空串/名称/路径/中文/大小写/无命中         | 与现有 fuzzy 排序一致；服务+算法单测                                  |
| MFH03 | 无命中后外部新建文件，再查询/补扫                     | refresh 绕过缓存；服务和 hook 单测                                    |
| MFH04 | 延迟响应期间改变关键词、identity、service，或关闭面板 | 旧结果不得覆盖；hook 单测                                             |
| MFH05 | 查询报错后输入更多文字                                | 无重试循环；关闭重开恢复；hook 单测                                   |
| MFH06 | 改 .zcodeignore、两个 service/identity 使用相同路径   | 新规则生效，隔离成立；服务单测                                        |
| MFH07 | 文件树与命令中心原接口                                | 分块返回及 shared 匹配兼容；既有单测                                  |

已确认边界：保留空 query、数量、排序、失败终态、miss-refresh；不新增持久索引、文件监听系统或搜索 UI。主题与语言不改变语义；使用同一界面和 canonical mention，重点验证查询契约与桌面/手机交互。E2E 新用例保留 manual-review/pending，推广/CI 准入按既有流程，不在本次自动转正。
