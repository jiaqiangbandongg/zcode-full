# ZCode 发版通知卡片

## 目标

正式版本发布后，`release:notify:feishu` 使用 Zara 向配置的飞书群发送 Card 2.0 更新说明。卡片内容来自 infra 编辑后的共享目录 `macos-arm64/latest.yml.releaseNotes`，同时在移动端和桌面端保持清晰、克制的信息层级。

## 信息结构

- Header：版本号、正式发布状态和通知图标，使用蓝色主题。
- 摘要块：仅展示“本次更新已发布”和新功能/问题修复数量，不展示 CI、发布人或内部地址。
- Changelog：只展示非空分区；“新功能”优先展开，纯修复版本直接展开“问题修复”，未知标题归入“其他更新”并保留完整条目。
- 链接：底部只保留官网与文档两个跳转按钮，不产生服务端回调。

## 视觉与兼容性

- 使用 Card 2.0 `schema: "2.0"` 和 `default` 宽度。
- 主色限定为蓝、白、灰；不使用渐变、大图、庆祝 emoji 或高饱和装饰。
- 通过容器内边距、浅色背景和折叠分区控制长文密度，不使用大标题堆叠。
- 飞书会话预览必须包含版本号；卡片允许转发，不支持旧客户端的情况由飞书自身降级展示。

## 发送边界

- 测试 tag、sandbox release 和 `ZCODE_ENV=test` 不发送正式通知。
- 只有稳定版发布成功后，手动执行 `release:notify:feishu` 才发送。
- Tag pipeline 自动使用 `CI_COMMIT_TAG` 作为版本；`CI_RELEASE_BRANCH=1` 的非 Tag 演练必须显式提供 `ZARA_RELEASE_NOTIFY_VERSION`，否则通知 Job 在调用 Zara 前失败。
- 默认接收范围覆盖 5 个已确认的 ZCode 用户、内部与平台内测群；通过逗号分隔的 `ZARA_RELEASE_NOTIFY_RECEIVE_ID` 统一维护，新增群时同步更新 CI 回归断言。
- 正式通知读取 `${ZCODE_CI_SHARED_ROOT}/${TARGET_OUTPUT_DIR}/macos-arm64/latest.yml` 的 `releaseNotes`；清单缺失、版本与通知版本不一致或日志为空时直接失败，不回退仓库 `CHANGELOG.md`。
- 每个接收方独立发送并使用“版本 + 接收方”派生的稳定 Feishu `uuid`；单群失败不阻止后续群，最终错误会给出失败清单。超过飞书一小时去重窗口后，只能通过 `ZARA_RELEASE_NOTIFY_RETRY_RECEIVE_ID` 精确补发失败群。
- 发送前会移除 Markdown 链接目标和裸露内网 URL，并拒绝超过 24 KiB 安全预算的卡片，为飞书 30 KiB 请求上限预留序列化余量。
- dry-run 只输出卡片 JSON，不调用飞书 API。
- Zara/Feishu 失败日志只保留状态码、错误码和最多 500 字符的脱敏摘要，不记录完整第三方响应。
