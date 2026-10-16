# CUA 权威判定去重审计

状态：实现契约

## 目标

整体审计 official CUA 从 producer 身份/前台验证到 consumer 媒体投影的判定链，
删除会用较弱镜像覆盖权威结果、把具体冲突降级成成功、或没有任何读取方的重复状态；
同时保留跨异步边界的 TOCTOU 复核和不同层承担的独立不变量。

## 判定原则

```text
同一事实、同一时点
  authoritative source 已给出结论
    └─ cache / mirror / weaker source 不得重新否决或放行

跨 await / native dispatch / hook / provider projection
  系统状态可能已经变化
    └─ 新时点复核保留（TOCTOU gate）

不同不变量
  identity / focus / raster bytes / adjacency / budget
    └─ 各自保留；不能因为都“检查失败”就合并
```

本轮具体 authority map：

```text
producer direct applicationInfo(pid)
  ├─ exact result ───────────────> PID identity authority
  ├─ absent/error ───────────────> exact listApplications(pid) availability fallback
  └─ concrete conflicting PID ──> fail closed（不得由列表洗白）

producer activateAppFrameSurface
  ├─ LiveFrontmostPid + exact focus ──> activation transaction authority
  └─ later captureApp exact surface ──> later TOCTOU identity/focus check（保留）

consumer official MCP authority
  └─ modelContentProtection=official_cua_frame_v1 ──> 唯一 Host 保护开关

consumer provider projection
  image immediately followed by image_ref ──> one deliverable coordinate pair
  orphan image_ref / unrelated image ───────> whole result unavailable
```

## 接受的 case 与剪枝

| Case         | 输入                                                                                | 预期                                                      | 证据                       |
| ------------ | ----------------------------------------------------------------------------------- | --------------------------------------------------------- | -------------------------- |
| CUA-AUTH-01  | direct PID lookup 返回具体不同 PID，同时 list 中存在请求 PID                        | 立即拒绝；不 launch、不 activate                          | producer unit              |
| CUA-AUTH-02  | direct PID lookup 缺失或暂时抛错，list 中有唯一请求 PID                             | 允许 exact PID fallback                                   | producer unit              |
| CUA-AUTH-03  | native surface activation 已证明 WindowServer 前台，但随后 app-list active 镜像落后 | 不覆盖 native 成功                                        | producer unit + live macOS |
| CUA-AUTH-04  | native success 缺少/错配 foreground PID                                             | fail closed                                               | producer unit              |
| CUA-AUTH-05  | activation 后 exact surface 被替换或失焦                                            | later TOCTOU gate fail closed                             | producer unit              |
| CUA-MEDIA-01 | deliverable image 与 image_ref 直接相邻                                             | 保持原子对和顺序                                          | adapter unit               |
| CUA-MEDIA-02 | image 与 image_ref 之间有空白/任意 block                                            | 整体错误化，不暴露 frame_id                               | adapter unit               |
| CUA-MEDIA-03 | 结果中有可投递的无关图片，另有 orphan image_ref                                     | 无关图片不能替 orphan 授权；整体错误化                    | adapter unit               |
| CUA-HOST-01  | authority-verified official CUA 注册                                                | 只设置 `modelContentProtection`，不存在并行 preserve flag | core unit + typecheck      |

剪枝结论：

- 不新增 conversation session 状态组合；改动不触碰 desktop continuous、mobile
  replayable、owner/lease、queue 或 workspace identity。
- Windows/Linux activation 的 live postcondition 是各平台独立事实，不从 macOS
  native surface authority 推导，本轮只跑静态/单测回归，不宣称 live 平台通过。
- executor 在 hook 后的 final attestation、global keyboard 派发前/分步派发间的
  frontmost 复核、activation 后 exact surface capture 都跨越了可变时点，明确保留。
- media bridge 的入站完整性与 adapter 的 provider 可投递性属于不同不变量，明确保留；
  adapter 只收紧“每个引用必须与自己的 raster 直接相邻”，不按工具名猜 authority。

## 验收

- 先让上述负例在旧实现上失败，再做最小修复；
- producer/consumer 相关定向测试全绿；
- producer 全量测试，consumer typecheck、lint、受影响单测全绿；
- macOS 真实模型至少覆盖一次观察、文件面板激活/上传与后续输入；
- MR 在审计完成前保持 Draft，完成后重新跑 review/gate 再恢复 Ready。
