# ZCode 满血版

<div align="center">
  <img src="public/logo/icons/1024x1024.png" alt="ZCode" width="128" height="128" />
</div>

<p align="center">
  <strong>补齐 Git 自动备份功能，支持阿里云 OSS，用户完全掌控。</strong>
</p>

<p align="center">
  基于 <a href="https://github.com/zai-org/ZCode">zai-org/ZCode</a> 的社区增强 Fork
</p>

<div align="center">
  <img src="public/screenshots/git-backup-welcome.png" alt="Git 自动备份引导" width="600" />
  <p><em>首次启动时的 Git 自动备份配置引导</em></p>
</div>

---

## 为什么需要满血版？

ZCode 官方开源版本缺少了一项重要功能：**Git 仓库自动备份**。

我们认为，一个优秀的 AI 编程工作台应该具备代码资产保护能力。意外丢失代码是每个开发者的噩梦——磁盘故障、误操作 `git reset --hard`、甚至 AI 误删文件，都可能造成不可挽回的损失。

ZCode 满血版补齐了这个缺失的功能。你的 `.git` 仓库会被安全地自动备份到**你自己的**阿里云 OSS 存储桶，使用非对称加密保护，密钥完全由你持有。

## Git 自动备份

### 工作原理

1. **首次启动时引导配置**——主动询问你是否开启自动备份，并引导你填写自己的阿里云 OSS 凭证
2. **扫描 `.git` 目录**——打包 objects、refs、reflog 等完整仓库历史
3. **本地加密**——使用 AES-256-CTR 加密数据，RSA-OAEP 包裹对称密钥，密钥对在你的设备上生成
4. **上传到你的 OSS**——备份文件上传到你自己的阿里云 OSS 存储桶，不经过任何第三方服务器
5. **生成备份清单**——每次备份生成 `repo_backup_manifest`，记录文件清单和哈希校验

### 我们的设计原则

| 设计原则 | ZCode 满血版 |
| --- | --- |
| 备份前主动告知用户 | **是**，首次启动明确询问，需要用户主动确认开启 |
| 用户持有全部加密密钥 | **是**，RSA 密钥对在本地生成，私钥从不离开你的设备 |
| 关闭开关真的有效 | **是**，关闭后完全停止，不会静默重启或绕过设置 |
| 备份存储由用户决定 | **是**，上传到你自己的阿里云 OSS，凭证由你配置和管理 |
| 不填写配置即不启用 | **是**，跳过引导后与官方开源版完全一致，无任何额外行为 |

### 如何使用

1. 启动 ZCode 满血版，首次运行时会弹出引导对话框
2. 选择"开启自动备份"，填写你的阿里云 OSS 配置：
   - AccessKey ID / Secret
   - Bucket 名称
   - Region（如 `oss-cn-hangzhou`）
3. 完成！后续备份自动进行
4. 也可以选择"暂不开启"，随时在 **设置 → Git 自动备份** 中配置

> 如果你不需要这个功能，跳过即可。满血版不会做任何你不知道的事情。

---

## 与官方开源版的关系

本仓库 fork 自 [zai-org/ZCode](https://github.com/zai-org/ZCode)，保持与上游同步。所有新增功能以独立模块形式添加，不修改原有核心逻辑。

```bash
# 同步上游更新
git fetch upstream
git merge upstream/main
```

## 开发指南

与官方版一致，参见下方说明。

### 初始化

准备 Git、Node.js **24.14.0** 和 pnpm **10.33.2**，版本以 [mise.toml](mise.toml) 为准。

```bash
pnpm bootstrap
```

| 入口 | 用途 | 开发命令 |
| --- | --- | --- |
| Desktop | Electron 桌面应用 | `pnpm dev:desktop` |
| Web / ZCode 命令行版 | 终端与浏览器工作台 | `pnpm dev:web` |
| Agent CLI | 终端 Agent 运行时 | `pnpm --filter @zcode/cli dev` |

详细的开发、配置、打包说明请参考 [官方 README](https://github.com/zai-org/ZCode/blob/main/README.md)。

## 仓库结构

| 目录 | 职责 |
| --- | --- |
| `packages/desktop` | Electron Main、Host、Renderer 与桌面打包 |
| `packages/web` | Web 客户端 |
| `packages/server` | HTTP / WebSocket 服务与远程连接 |
| `packages/ui` | 共享 React 组件、hooks 与 Zustand 状态 |
| `packages/services` | 业务服务与持久化 |
| `packages/services/src/git-backup` | **Git 自动备份服务（满血版新增）** |
| `packages/shared` | 共享协议和类型 |
| `apps/zcode-cli` | Agent CLI、TUI、运行时与工具 |

## 背景

2026 年 9 月，安全研究人员发现 ZCode 桌面版存在[静默上传用户工作区 `.git` 完整历史](https://blog.ferstar.org/posts/zcode-silent-workspace-snapshot-upload/)的行为，相关讨论见 [zai-org/feedback#707](https://github.com/zai-org/feedback/issues/707)、[#709](https://github.com/zai-org/feedback/issues/709)、[#711](https://github.com/zai-org/feedback/issues/711)、[#715](https://github.com/zai-org/feedback/issues/715)。

随后 Z.ai 将 ZCode 客户端开源，但[上传相关代码在开源前被完全剥离](https://github.com/zai-org/ZCode/issues/9)。

本项目认为 Git 仓库备份本身是有价值的功能——前提是用户知情、用户掌控、用户可关闭。因此我们将这个功能以透明、安全的方式重新实现。

## 许可

本项目继承上游 [Apache License 2.0](LICENSE)。

## 项目声明

功能与优惠范围、维护规则、执行与数据风险，以及许可和第三方版权说明，详见 [NOTICE.md](NOTICE.md)。