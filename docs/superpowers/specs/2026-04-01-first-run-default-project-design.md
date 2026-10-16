# 启动时自动兜底非项目对话工作区（已替代默认项目）

## 概述

app 启动时优先恢复 `lastWorkspaceSession`；如果没有任何可恢复的工作区，则确保存在 `<dataBaseDir>/.zcode/workspace/default`，以 `workspacePurpose=conversation` 激活并预热。UI 保持“未选择项目”，用户可以直接对话。

## 判断标准

- `lastWorkspaceSession.length > 0` → 正常恢复上次会话
- `lastWorkspaceSession.length === 0` 或 settings 文件不存在 → 兜底进入 conversation backing workspace

## 平台范围

Desktop（Electron）优先落地；Web 保持同样的启动语义。

## Service 层改动

### fileService 扩展

在 `IFileService` 提供幂等方法：

```typescript
interface IFileService {
  ensureConversationWorkspace(): Promise<{
    path: string;
    created: boolean;
    workspacePurpose: "conversation";
  }>;
}
```

#### `ensureConversationWorkspace()`

- 检查 `<dataBaseDir>/.zcode/workspace/default` 是否存在
- 不存在：`mkdir` 创建，返回 `{ path, created: true }`
- 存在：返回 `{ path, created: false }`

该方法是幂等的，多次调用不会产生额外副作用。

### settings 写入约束

- `recentProjects` 和 `lastOpenTabs` 可能在同一条打开工作区链路里先后写入
- settings 更新必须串行化，避免后写入的补丁把前一个字段覆盖掉

## Desktop 启动入口

Desktop 在 main 进程启动时读取 settings：

1. `lastWorkspaceSession.length > 0` 时，不分配新路径，交给 renderer 正常恢复会话
2. `lastWorkspaceSession.length === 0` 时，确保 backing path 存在，并把完整 conversation descriptor 传给 renderer，同时作为 Agent warmup target

这样启动时只有两条主路径：恢复会话，或者直接进入默认工作区。

## 涉及文件

| 文件 | 改动 |
|------|------|
| `packages/services/src/file/fileService.ts` | 实现 backing workspace 路径与幂等创建 |
| `packages/shared/src/protocol.ts` | 增加 `WorkspacePurpose` 与 persisted descriptor |
| `packages/desktop/src/main/startupWorkspace.ts` | 启动时解析恢复会话/conversation fallback |
| `packages/desktop/src/main/index.ts` | 接入启动兜底逻辑 |

完整当前设计见 [2026-07-10-non-project-conversation-workspace-design.md](./2026-07-10-non-project-conversation-workspace-design.md)。
