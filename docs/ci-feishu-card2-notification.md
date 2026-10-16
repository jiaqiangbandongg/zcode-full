# CI 构建产物飞书 Card 2.0 通知

## 范围

本规范只覆盖构建阶段的 `notify:feishu:<platform>:<arch>` 通知，不改变正式发版
通知 `release:notify:feishu`。平台构建成功后仍各发送一条消息；sandbox/test tag
仍跳过通知；通知发送失败仍不阻断主流水线。

## 消息契约

通知由 CI 脚本组装 Feishu Card 2.0，交给 zcode-internal 的通用飞书通知服务发送：

```
POST <ZCODE_FEISHU_NOTIFY_BASE_URL>/api/v1/feishu/messages
Authorization: Bearer $ZCODE_FEISHU_NOTIFY_TOKEN
```

服务用 ZCode Infra 应用投递，CI 侧不再持有飞书应用凭证。`scene` 为
`ci.build.completed` / `ci.build.failed`；收件人优先用 CI 自己的 `FEISHU_RECEIVE_ID`
（显式传给服务），未配置时回落到服务端的场景默认收件人。原 Template 所使用的字段保持不变：

- 标题：`构建完成 · 测试/生产 · <平台架构> · <分支名>`
- 分支：`CI_COMMIT_REF_NAME`（仅在标题展示）
- 提交人：`CI_COMMIT_AUTHOR`
- 提交信息：`CI_COMMIT_MESSAGE`

提交作者的 @ 改为卡片内的 `{{mention:<CI_COMMIT_AUTHOR>}}` 占位符，由通知服务用统一的
「人员配置」目录解析成 `<at id=ou_xxx></at>`——该目录就是控制台「人员配置」页维护的那份，
覆盖原 `zcode-labs` 对照表的 15 位 GitLab 用户。也可通过 `FEISHU_MENTION_OPEN_IDS`
（逗号分隔的飞书 `open_id`）额外指定 @ 对象，这些显式 id 仍直接内联在卡片里。占位符未命中时
服务退化为纯文本，不伪造 @；未命中且未额外配置时不渲染「相关人员」区块。

成功卡片不在正文直接展示产物 URL，而是在正文底部提供“下载产物”按钮；失败卡片不展示产物 URL，
在正文底部提供“查看失败 Job”按钮，跳转到同一流水线中对应失败构建 Job 的 `web_url`；该地址由
`notify-feishu-ci.mjs` 使用 CI 变量 `GITLAB_ACCESS_TOKEN`（或兼容的 `GITLAB_PRIVATE_TOKEN`）查询 GitLab Pipeline Jobs 得到。对应 URL 缺失时不渲染按钮；查询失败时失败通知 Job 以非零状态结束并打印原因。
两个按钮均使用 `default` 描边样式和 `default` 自适应宽度。

环境、架构、触发人和分支只在标题或内部变量中处理，不再作为正文独立字段展示。卡片使用 Card 2.0
`schema: "2.0"`、蓝色 header 和浅色信息块；按钮仅用于打开产物或 Job 地址，不新增外部回调
或其他业务交互。长文本必须在卡片 JSON 中安全转义，并设置与飞书请求限制
匹配的大小校验；提交人和提交信息作为不可信输入统一转义 Markdown/HTML 特殊字符，并限制长度。

构建失败时为对应平台增加失败通知：标题将“构建完成”替换为“构建失败”，正文展示提交人、
提交信息并提供 GitLab Job 地址按钮；失败卡片不展示产物下载地址。触发人和分支不作为正文独立字段展示。
成功卡片使用蓝色 Header 与 `success_colorful` 图标，失败卡片使用红色 Header 与
`fail_colorful` 图标，确保两种状态在通知列表中可以快速区分。

配置 `FEISHU_HEADER_ICON_IMAGE_KEY` 后，Header 改用飞书 `custom_icon` 展示 ZCode
Logo；该 key 必须由同一个飞书应用在具备 `im:resource:upload` 或 `im:resource` 权限后
上传 `public/icon_512@2x.png` 获得。未配置时回退上述成功/失败标准图标。

## 配置与测试

需要新增 GitLab CI/CD 变量 `ZCODE_FEISHU_NOTIFY_TOKEN`（与服务端同值），可选
`ZCODE_FEISHU_NOTIFY_BASE_URL`（默认 `http://intranet.example.invalid:3011`）。生产接收方仍由
GitLab 的 `FEISHU_RECEIVE_ID` 提供。构建通知单元测试和后续手动验证统一使用临时测试群
`oc_5725795450da6920872fdb25412848bf`，不得把该测试群写入生产 CI 默认配置。

构建通知只有这一条发送链路：CI 侧不持有任何飞书应用凭证，`FEISHU_APP_ID` /
`FEISHU_APP_SECRET` 与该脚本无关。缺少 `ZCODE_FEISHU_NOTIFY_TOKEN` 时脚本直接报错退出，
不会静默降级到别的发送身份——否则群里会混入非 ZCode Infra 的机器人。

## 失败边界

通知服务调用失败时脚本重试一次；两次都失败才返回非零，因为通知不能静默丢失。
`notify-feishu-ci.mjs` 捕获该状态并以零退出，确保通知故障不改变构建、发布和后续
流水线状态。
