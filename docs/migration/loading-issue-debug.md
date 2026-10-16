# 界面一直加载问题排查

> **状态：历史排障记录。** 本文记录旧 store/task-stream 架构下的一次加载问题，
> 所列 `memoryStore`、`outputStyleStore` 等路径已不存在；不要将这些步骤用于当前 V4 UI。

## 症状
应用启动后一直停留在主界面加载状态

## 已确认正常的部分

✅ 服务注册成功（日志显示）：
```
[rpc:register] channel "hooks"
[rpc:register] channel "memory"
[rpc:register] channel "output-style"
local services ready, all channels registered
```

✅ 新增代码没有语法错误
✅ Store 没有被自动调用

## 可能的原因

### 1. 原有代码的类型错误
检查发现有一些原有代码的类型错误（非我们新增代码）：
- `src/hooks/taskStreamEventHandlers.ts` 中有多处类型错误

### 2. 浏览器缓存问题

## 解决方案

### 方案 1：清理并重新构建（推荐）

```bash
# 1. 停止当前进程（Ctrl+C）

# 2. 清理所有构建产物
cd E:\GitProject\z-code\z-code
rm -rf packages/desktop/out
rm -rf packages/ui/dist
rm -rf packages/services/dist
rm -rf packages/shared/dist

# 3. 清理依赖缓存
rm -rf node_modules/.cache
rm -rf packages/desktop/node_modules/.vite

# 4. 重新构建
pnpm run build

# 5. 启动（增加内存限制）
$env:NODE_OPTIONS="--max-old-space-size=4096"
pnpm run dev:desktop
```

### 方案 2：检查浏览器控制台

打开开发者工具（F12），查看 Console 标签页：
1. 是否有 JavaScript 错误
2. 是否有网络请求失败
3. 查看错误堆栈

### 方案 3：临时移除新代码测试

如果上述方案都不行，可以临时移除我们新增的服务注册来验证：

```typescript
// 在 packages/services/src/node.ts 中
// 注释掉这三行：
// .register(IHooksService, createHooksService())
// .register(IMemoryService, createMemoryService())
// .register(IOutputStyleService, createOutputStyleService())
```

然后重新构建看是否能正常启动。如果能启动，说明我们的代码有问题；如果还是不能启动，说明是其他原因。

## 调试信息收集

如果问题仍然存在，请收集以下信息：

1. **浏览器控制台错误截图**
2. **完整的启动日志**（从开始到卡住的部分）
3. **构建是否有错误**（运行 `pnpm run build` 的输出）

## 我们的代码位置

如果需要回滚：
- `packages/shared/src/hooks.ts`
- `packages/shared/src/memory.ts`
- `packages/shared/src/output-style.ts`
- `packages/services/src/hooks/`
- `packages/services/src/memory/`
- `packages/services/src/output-style/`
- `packages/ui/src/store/hooksStore.ts`
- `packages/ui/src/store/memoryStore.ts`
- `packages/ui/src/store/outputStyleStore.ts`

## 注意

新增的服务和 Store **没有自动初始化逻辑**，只有在 UI 组件中手动调用 `initialize` 方法才会执行。因此理论上不应该影响应用启动。
