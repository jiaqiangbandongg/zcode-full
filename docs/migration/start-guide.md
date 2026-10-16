# 开发环境启动指南

## ✅ 问题已解决

我们已修复服务注册问题，现在应用应该可以正常启动了。

### 修复内容

在 `packages/services/src/node.ts` 中添加了：
1. 导入三个新服务的接口和实现
2. 在 `createLocalServiceCollection` 中注册服务实例

## 🚀 启动步骤

1. **清理并重新构建**（推荐）：
```bash
# 清理缓存
cd packages/desktop
rm -rf node_modules/.vite .vite

# 回到项目根目录
cd ../..

# 增加内存限制并启动
$env:NODE_OPTIONS="--max-old-space-size=4096"
pnpm run dev:desktop
```

2. **如果仍然遇到内存问题**：
```powershell
# 关闭所有终端窗口
# 打开新的 PowerShell
$env:NODE_OPTIONS="--max-old-space-size=4096"
pnpm run dev:desktop
```

## ✅ 已完成的功能

所有核心架构已完成：

### 服务层
- ✅ Hooks 服务 - 管理 Claude Code hooks 配置
- ✅ Memory 服务 - 管理 MEMORY.md 文件
- ✅ OutputStyle 服务 - 管理输出样式

### Store 层
- ✅ hooksStore - Hooks 状态管理
- ✅ memoryStore - Memory 状态管理
- ✅ outputStyleStore - OutputStyle 状态管理

### 配置文件位置
- Hooks: `<workspace>/.claude/settings.json`
- Memory: `<workspace>/MEMORY.md`
- OutputStyle: `~/.claude/output-styles/`

## 🎯 后续工作

剩余工作主要是 UI 层：
1. 迁移设置页面组件
2. 集成测试验证完整功能

## 📝 检查应用是否正常

启动后，检查以下功能：
- [ ] 应用能正常打开主界面
- [ ] 没有 TypeScript 编译错误
- [ ] 控制台没有服务相关的错误

如果遇到问题，请查看控制台错误日志。
