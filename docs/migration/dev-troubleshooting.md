# 开发环境常见问题解决方案

## 问题：Vite 内存分配失败

```
[vite] memory allocation of 668992 bytes failed
```

### 解决方案 1：增加 Node.js 内存限制（推荐）

在 Windows PowerShell 中运行：

```powershell
$env:NODE_OPTIONS="--max-old-space-size=4096"
pnpm run dev:desktop
```

或者在 CMD 中运行：

```cmd
set NODE_OPTIONS=--max-old-space-size=4096
pnpm run dev:desktop
```

### 解决方案 2：清理缓存

```bash
# 清理 Vite 缓存
cd packages/desktop
rm -rf node_modules/.vite
rm -rf .vite

# 清理项目级缓存
cd ../..
rm -rf node_modules/.cache

# 然后重新启动
pnpm run dev:desktop
```

### 解决方案 3：重启终端

有时关闭当前终端窗口，打开新终端可以解决问题。

## 问题：类型错误

如果看到类型错误，先尝试：

```bash
# 重新构建依赖的包
pnpm run build

# 或只构建 shared 包
cd packages/shared
pnpm run build
```

## 已迁移的功能

我们已经成功迁移了以下功能的核心架构：

- ✅ Hooks 服务和 Store
- ✅ Memory 服务和 Store
- ✅ OutputStyle 服务和 Store

### 配置文件位置

- Hooks: `<workspace>/.claude/settings.json`
- Memory: `<workspace>/MEMORY.md`
- OutputStyle: `~/.claude/output-styles/`

### 后续工作

剩余工作主要是：
1. UI 组件迁移
2. 服务实例注册
3. 集成测试
