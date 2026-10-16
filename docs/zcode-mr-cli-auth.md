# zcode-mr 的 CLI 认证与创建契约

`setup`、`mr`、`create` 统一使用目标 GitLab host 的 glab 登录状态；凭据来源由 glab 自己管理，helper 不读取环境 Token、凭据文件或自行发送 HTTP 请求。

```text
setup → glab auth status --hostname <origin host> → ready / 安装或登录指引
mr / create → 同一认证检查 → 校验分支并推送 → glab api 查询已有 MR
                                             ├─ 已存在：返回 IID / URL
                                             └─ 不存在：glab api 创建 → 返回 IID / URL
```

- `mr` 与 `create` 行为一致；`create duo <target>` 与 `mr --duo <target>` 保持兼容。
- 认证不可用时在推送前失败。Git 推送仍使用 Git 本身的 SSH/HTTPS 认证，glab 的登录状态不保证 push 权限。
- 查询和创建均通过 glab CLI，显式指定同一 host。创建正文经 JSON stdin 传入，保留中文、换行和 shell 字面量，不把 token 放进命令参数。
- glab 查询失败不继续创建；POST 出错不自动换凭据重试，避免网络不确定时重复创建。
- 推送成功但 MR 查询/创建失败：退出非零，返回明确失败状态及预填链接。只有 `created` / `already_exists` 能被报告为成功。
- 描述规范、分支保护、DUO 标题及已有 MR 幂等查询保持不变。

回归覆盖：CLI 缺失/未登录时不推送；已登录而无环境 Token 可创建；环境 Token 的解释交给 glab；主机一致；已有 MR 不重复创建；正文转义；查询/创建失败退出非零；两种命令和 DUO 行为一致。

## 未登录时默认推荐 Personal Access Token

- 已认证时直接复用，不重新登录或迁移凭据存储。未登录时输出目标 host 的 PAT 创建页面链接、`api,write_repository` 权限建议和 `Token` 登录方式。
- 在 GitLab 头像 → Edit profile → Access / Personal access tokens（旧版可能直接叫 Access Tokens）创建 Token：填写名称与有效期，勾选 `api` 和 `write_repository`，创建后当场保存。Token 值只在创建时显示，不能从列表重新查看。
- 用户在 glab 的隐藏 Token 输入框中输入；不粘贴到聊天、不写入命令参数。随后运行 setup，再通过 glab 做只读项目访问验证。
- Git/API 协议和凭据存储沿用当前用户的选择。当前用户要求保持配置文件存储时，用 glab 的 `--insecure-storage`；该参数不是所有新环境的默认要求。隔离测试使用私有临时 GLAB_CONFIG_DIR，并显式选择配置文件存储，结束后清理，避免写入真实系统钥匙串。
- 本次自建 GitLab 的 Web 测试提示缺少 `client_id`。默认 Token 流程不需要部署 OAuth 应用；只有用户明确选择 Web/Device 时再处理其前置配置。

参考：[GitLab PAT 创建说明](https://docs.gitlab.com/user/profile/personal_access_tokens/)、[权限说明](https://docs.gitlab.com/security/tokens/access_token_scopes/)。
