# File Tools Atomic Write E2E

这个 harness 覆盖 CLI file tools 的真实 handler 到真实 `NodeFileSystemAdapter` 路径，不依赖模型、不访问网络，也不需要 provider fixture。

Cases:

- `write-preserves-executable-mode`：`Write` 覆盖已有 `0755` 脚本后保留执行位。
- `edit-preserves-executable-mode`：`Edit` 修改已有 `0755` 脚本后保留执行位。
- `write-rejects-symlink-target`：`Write` 写入 symlink 路径时拒绝穿透 symlink，且真实 target 内容不变。

从 repo root 先构建依赖的 dist：

```bash
pnpm --filter @zcode/contracts build
pnpm --filter @zcode/shared-types build
pnpm --filter @zcode/adapters build
pnpm --filter @zcode/core build
```

然后运行：

```bash
node apps/zcode-cli/e2e/file-tools-atomic-write/run.mjs
```

Windows 会返回 skipped，因为此 case 验证的是 POSIX `0755` mode 语义。
