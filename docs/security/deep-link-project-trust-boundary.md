# Deep Link 与项目配置信任边界

> 状态：Implemented（2026-08-06）
>
> 关联规格：`docs/specs/workspace-hook-trust.md`

## 背景

ZCode Desktop 支持 `zcode://workspace/open?path=...` 打开本地工作区，也会在项目发现范围内读取
`zcode.json`、`.zcode/config.json` 的 Hook 声明，以及 `.zcode/agents/*.md` 的 subagent profile。
外部 deep link、repository 文件和远端 workspace 都不属于用户级可信配置：确认“打开目录”不等于确认
“执行目录中的代码”。

## 安全边界

- Windows `zcode://` 协议命令必须将外部 URL 放在 `--` 之后：生产态为
  `"<ZCode.exe>" "--" "%1"`，开发态为 `"<electron.exe>" "<entry>" "--" "%1"`。
  `registerDeepLinkProtocol` 是注册 owner；每次正常启动都覆盖旧注册，避免保留不安全模板。
- Windows 打包产物在签名前关闭 `enableNodeCliInspectArguments`，使旧注册尚未更新时的
  `--inspect` / `--inspect-brk` 也不能启动主进程调试器。该设置不修改未打包的开发 Electron，
  也不关闭 Agent 启动所需的 `runAsNode`。
- 参数隔离必须发生在 Electron 原生启动解析之前。应用 JavaScript 中的 URL 校验和单实例锁
  不能替代这一边界；OAuth、支付、workspace、share 回调仍保留原有路由与校验。
- `zcode://workspace/open` 是外部输入，不能等价于用户在应用内选择目录。
- deep link 传入的 workspace path 必须在任何 filesystem probe 前拒绝 UNC / 网络路径。
- deep link 打开本地目录前必须有用户确认；用户取消时不得缓存或投递 workspace path。
- deep-link 确认只授权打开路径，不建立 Workspace Hook Trust。
- 项目级 `zcode.json` 与 `.zcode/config.json` Hook 声明视为未信任代码，默认不能进入可执行路径。
- discovery 只生成 immutable `WorkspaceHookBundleSnapshot`；Runtime admission 必须在 Hook lifecycle 和进程启动前完成。
- 持久 Trust 只按 `workspaceIdentity + hookDeclarationDigest` 命中；bundle digest 用于保证审核和执行快照一致。
- Trust 只能由受信任 Host 的 `设置 → 钩子 → 工作区` 审核，或显式 `zcode hooks trust` 命令建立；repository、环境变量和普通 permission answer 都不能授权。
- managed `deny` 高于 persistent Trust，并在下一次 dispatch gate 生效。
- 用户级 Hook 与已启用插件 Hook 继续按各自既有可信来源规则运行。
- 项目级 `.zcode/agents/*.md` 不得通过 frontmatter 改写 child runtime 权限模式；`permissionMode` 只对用户级或受信插件 profile 生效。

## Rollout 与回滚

```text
外部 URL → Windows 协议注册 owner 写入的 exe [entry] -- URL
         → Electron 将 -- 后的内容作为数据 → 既有 Deep Link 路由与确认
旧注册 → 新 Windows 产物的 Inspector fuse 拒绝调试参数 → 正常启动后重写安全注册
```

```text
trusted embedder / Host
  ├─ workspaceHookTrustEnabled = false
  │    -> project Hook hard block
  │    -> 不读取 Trust store
  │    -> 不创建 review request
  │    -> 保留磁盘上的 Trust records
  └─ workspaceHookTrustEnabled = true
       -> discovery snapshot
       -> managed policy
       -> persistent Trust evaluation
       -> pending review or admitted dispatch
```

`ZCodeAppOptions.workspaceHookTrustEnabled` 是 trusted bootstrap 输入，不从 workspace/project 配置或环境变量解析。
通用 App 工厂默认关闭；ZCode Protocol 的 Desktop/Web/Mobile workspace Host 在受信边界显式开启。出现安全问题时，
Host 可关闭该字段恢复 hard block，不删除用户记录。该 flag 只决定是否进入 Trust admission，绝不代表自动信任。

## 观测与隐私

Workspace Hook Trust 通过现有 Logger Port 记录低频结构化事件，包括 review created、trust selected、
timeout、superseded、snapshot mismatch、policy block、Trust store failure 和 toggle/rebuild failure。
日志只包含稳定 reason code、generation、workspace identity 的 SHA-256 摘要，以及 bundle/declaration digest 的短摘要；
不得记录命令原文、脚本内容、source path、Trust payload 或 interaction response body。

## 验证要点

- Windows 生产态和开发态注册均将 `--` 放在 URL 前，重复注册仍保持安全模板；macOS/Linux
  注册行为保持不变，注册失败仍记录原有警告。
- 加入 `--` 后，OAuth、支付、workspace、share URL 在冷启动参数解析及单实例投递中保持不变。
- 真实 Electron 启动时，`--` 后的 `--inspect`、`--inspect-brk`、`--remote-debugging-port`
  不得开启调试器；Windows 发布包还须核验 Inspector fuse 已关闭，覆盖旧注册升级场景。
- Windows 发布验收覆盖新安装、旧注册升级、冷启动和已有实例，以及浏览器实际打开协议的路径。
- UNC deep link 不调用 filesystem stat，也不投递 `OpenWorkspacePath`。
- 用户取消 deep link 确认时，不打开目录。
- 用户确认本地目录后，未 Trust 的 project Hook 仍不能执行。
- flag 关闭时，即使 Trust store 已存在 exact record，也返回 `workspace_hooks_feature_disabled`，不读取记录、不发 review。
- flag 开启时，只有 exact declaration digest 命中才执行；配置变化后受影响声明重新审核。
- managed deny 能覆盖已有 record，并阻止后续 dispatch。
- stale task/run/remoteSession/generation/snapshot response 在 store mutation 前拒绝。
- 用户级 Hook、插件 Hook 和项目 subagent 权限边界不受此 rollout gate 扩权。
