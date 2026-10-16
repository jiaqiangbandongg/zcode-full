# Hooks、Memory 和 OutputStyle 迁移进度

## ✅ 已完成工作

### 1. 类型定义迁移 ✅
已将以下类型定义迁移到 `packages/shared/src`：
- `hooks.ts` - Hooks 相关类型定义
- `memory.ts` - Memory 相关类型定义
- `output-style.ts` - OutputStyle 相关类型定义

这些类型已在 `packages/shared/src/index.ts` 中导出，可以在整个项目中使用。

### 2. 服务层迁移 ✅
已完成所有三个服务的迁移，符合当前项目架构：

#### Hooks 服务 (`packages/services/src/hooks/`)
- `hooks.ts` - 服务接口定义和 descriptor
- `hooksService.ts` - 服务实现
  - 与 Claude Code 兼容的 hooks 配置格式转换
  - 支持 hooks 配置的读取、保存和启用/禁用管理
  - 配置保存在 `<workspace>/.claude/settings.json`
  - 启用状态保存在 `<workspace>/.claude/settings.local.json`

#### Memory 服务 (`packages/services/src/memory/`)
- `memory.ts` - 服务接口定义和 descriptor
- `memoryService.ts` - 服务实现
  - 支持按 agent 加载 memory 文件
  - 大小写敏感的文件检查
  - 配置保存在 `<workspace>/MEMORY.md`

#### OutputStyle 服务 (`packages/services/src/output-style/`)
- `outputStyle.ts` - 服务接口定义和 descriptor
- `outputStyleService.ts` - 服务实现
  - 内置 3 种样式：Default、Explanatory、Learning
  - 支持用户自定义样式
  - 配置保存在 `~/.claude/output-styles/`

### 3. Store 迁移 ✅
已完成所有三个 Store 的迁移，位于 `packages/ui/src/store`：

#### `hooksStore.ts`
- 状态管理：hooks 列表、启用状态、加载状态
- 操作：添加、更新、删除、切换启用状态
- 防重复加载机制（inflightLoads）

#### `memoryStore.ts`
- 状态管理：memory 内容、当前 agent ID
- 操作：加载、保存、清除
- 按 workspace + agent 缓存

#### `outputStyleStore.ts`
- 状态管理：样式列表、活跃样式
- 操作：添加、更新、删除、设置活跃样式
- 内置样式 + 用户自定义样式

### 4. 服务频道注册 ✅
已在 `packages/shared/src/channels.ts` 中添加：
- `Hooks: "hooks"`
- `Memory: "memory"`
- `OutputStyle: "output-style"`

### 5. 服务导出配置 ✅
已在 `packages/services/src/index.ts` 中导出所有服务和接口

### 6. 服务实例注册 ✅
已在 `packages/services/src/node.ts` 中：
- 导入接口和实现
- 在 `createLocalServiceCollection` 中注册三个新服务

## ⏳ 待完成工作

### 7. UI 组件迁移 ⏳
需要迁移以下组件到 `packages/ui/src/settings`：
- `SettingsHooks` - Hooks 设置主组件
- `HooksList` - Hooks 列表组件
- `HooksConfiguration` - Hooks 配置组件
- Memory 和 OutputStyle 相关组件

### 8. 集成测试 ⏳
完成上述工作后，需要：
- 测试 hooks 配置的读写
- 测试 memory 的读写
- 测试 outputstyle 的切换
- 测试与 ZCode app-server 系统的集成

### 9. 软连接支持（可选）⏳
如需支持软连接功能，参考：
- `packages/services/src/skills/skillsService.ts` 中的 `ensureSymlinkDirectory` 函数
- Windows 平台使用 `junction`，其他平台使用 `dir`

## 🔧 已修复的问题

### 问题：应用启动时一直加载
**原因**：创建了服务但没有在服务容器中注册

**解决方案**：
1. 在 `packages/services/src/node.ts` 中导入服务接口和实现
2. 在 `createLocalServiceCollection` 函数中注册三个新服务

**修改的文件**：
- `packages/services/src/node.ts`
  - 添加 import 语句
  - 添加服务注册到 ServiceCollection

## 架构说明

### 配置文件位置
- **Hooks 配置**: `<workspace>/.claude/settings.json`
- **Hooks 启用状态**: `<workspace>/.claude/settings.local.json`
- **Memory**: `<workspace>/MEMORY.md` (或其他 agent 对应的文件名)
- **OutputStyle**: `~/.claude/output-styles/` 目录下的 `.md` 文件

### 当前项目配置目录
当前项目使用 `~/.zcode/v2/` 作为主配置目录，但对于 workspace 级配置，仍然使用 workspace 目录下的 `.claude/` 目录。

## 后续建议

1. **优先级排序**：
   - 先完成 Memory 服务层（相对简单）
   - 再完成 OutputStyle 服务层
   - 最后完成 Store 和组件迁移

2. **适配建议**：
   - 参考 `packages/services/src/skills/skillsService.ts` 的实现方式
   - 参考 `packages/services/src/plugins/pluginsService.ts` 的软连接实现
   - 使用当前项目的服务层模式，而不是直接在前端使用 Tauri API

3. **测试策略**：
   - 先编写单元测试验证服务层功能
   - 再进行集成测试验证完整流程
   - 最后进行 UI 测试验证用户交互

## 相关文件

### 老项目参考
- `E:\GitProject\z-work\src\types\hooks.ts`
- `E:\GitProject\z-work\src\types\memory.ts`
- `E:\GitProject\z-work\src\types\output-style.ts`
- `E:\GitProject\z-work\src\stores\hooks.ts`
- `E:\GitProject\z-work\src\stores\memory.ts`
- `E:\GitProject\z-work\src\stores\output-style.ts`
- `E:\GitProject\z-work\src\services\hooks.ts`

### 当前项目已迁移文件
- `packages/shared/src/hooks.ts`
- `packages/shared/src/memory.ts`
- `packages/shared/src/output-style.ts`
- `packages/services/src/hooks/hooksService.ts`

## 注意事项

1. **软连接实现**：在 Windows 平台上需要使用 `junction` 类型，其他平台使用 `dir` 类型。

2. **路径处理**：确保正确处理 workspace 路径，特别是在远程 workspace 场景下。

3. **错误处理**：需要妥善处理文件不存在、权限不足等异常情况。

4. **性能优化**：考虑使用缓存机制，避免频繁的文件读写操作。
