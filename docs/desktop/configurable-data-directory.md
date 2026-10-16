# 可配置数据存储目录

## 概述

应用数据默认存储在 `~/.zcode/v2/`（`~` 即 `os.homedir()`）。用户可在「设置 → 通用 → 数据存储路径」中更改 `~` 对应的根目录，`.zcode/v2` 后缀不可更改。

## 目录结构

```
<dataBaseDir>/.zcode/v2/          ← 可配置的数据目录
  ├── logs/
  ├── perf/
  ├── sessions/
  ├── tasks-index.sqlite
  ├── telemetry-state.json
  └── ...

<dataBaseDir>/.zcode/workspace/default/  ← 非项目对话共享的真实工作目录

~/.zcode/v2/setting.json          ← Bootstrap 指针（永远在默认 homedir 下）
```

## Bootstrap 机制

`setting.json` 始终且只存在于默认 `homedir()/.zcode/v2/setting.json`，不跟随自定义目录迁移。它是整个路径切换的引导入口：

1. 主进程启动 → 从 `homedir()/.zcode/v2/setting.json` 读取 `dataBaseDir`
2. 如果有值 → 调用 `setDataBaseDir(dir)` 切换后续所有数据路径
3. 启动 host process 时通过环境变量 `ZCODE_DATA_BASE_DIR` 传递给子进程

路径解析优先级（`getDataBaseDir()`）：
1. `setDataBaseDir()` 设置的值（主进程 bootstrap）
2. `process.env.ZCODE_DATA_BASE_DIR`（host process 通过环境变量接收）
3. `os.homedir()`（兜底默认值）

## 复制行为

当用户更改数据目录时，会将旧目录的数据复制到新目录：

| 规则 | 说明 |
|------|------|
| **setting.json 及其瞬时文件不复制** | `setting.json` 是 bootstrap 指针，`setting.json.lock` 与 `setting.json.*.tmp` 是原子写入中间态，均只存在于默认 homedir 下；复制它们会导致迁移竞态或新旧目录冲突 |
| **已有文件不覆盖** | `force: false` — 如果目标目录已存在同名文件，保留目标版本。防止还原回旧目录时，新产生的数据被旧副本覆盖 |
| **新文件正常复制** | 源目录有、目标没有的文件会被复制过去 |
| **conversation workspace 暂未迁移** | 当前 `copyDataDirectory()` 只复制 `.zcode/v2`；`.zcode/workspace` 的非覆盖复制属于目标语义，待 CDD02/后续实现后再纳入数据目录迁移 |

### 场景示例

**正向迁移**（`/Users/a` → `/Users/a/test`）：
- `/Users/a/.zcode/v2/` 下的所有文件（除 setting.json）复制到 `/Users/a/test/.zcode/v2/`
- 目标目录如果不存在会自动创建

**还原**（`/Users/a/test` → `/Users/a`）：
- `/Users/a/test/.zcode/v2/` 下的文件复制到 `/Users/a/.zcode/v2/`
- 但 `/Users/a/.zcode/v2/` 里这段时间新产生的文件不会被覆盖
- `setting.json` 始终不受影响

## Windows 安装目录保护

Windows 上禁止把数据根目录设置到 ZCode 的安装目录或其子目录。原因是安装目录会被安装器和自动更新流程管理，若把 `<dataBaseDir>/.zcode/v2/` 放进去，后续更新可能覆盖或清理用户数据。

拦截规则：

| 来源 | 示例 |
|------|------|
| 当前桌面应用安装目录 | `process.resourcesPath` 的上级目录，例如 `C:\Users\{UserName}\AppData\Local\Programs\ZCode` |
| Program Files 安装目录 | `%ProgramFiles%\ZCode`、`%ProgramFiles(x86)%\ZCode`、`%ProgramW6432%\ZCode` |
| 用户 LocalAppData 安装目录 | `%LOCALAPPDATA%\Programs\ZCode` |

`packages/desktop/src/main/desktopRuntimeEnv.ts` 会在 Windows 打包态把当前安装目录通过 `ZCODE_WINDOWS_APP_INSTALL_DIR` 传给 host process。`packages/services/src/paths.ts` 在服务层按 Windows 路径规则做大小写不敏感的“等于或位于其下”判断，`packages/services/src/setting/settingService.ts` 在复制数据前执行该校验。UI 只展示错误提示，不作为唯一安全边界。

### 安装器阻断保护

Windows 安装包不会禁止用户选择任意安装目录。为覆盖历史版本已把数据放进安装目录的用户，NSIS assisted installer 会在用户选完安装目录、真正写入文件前检查最终安装目录及其子目录是否存在 `.zcode`：

1. 按 electron-builder assisted installer 的目录补齐规则计算最终安装目录
2. 若用户选择的是父目录，electron-builder 会安装到 `$INSTDIR\ZCode`，因此检查 `$INSTDIR\ZCode` 及其子目录
3. 命中后展示阻断页，提示安装目录或其子目录包含 `.zcode` 数据，继续安装或更新会让安装器清理历史会话和配置
4. 阻断页禁用“下一步”，并把“上一步”按钮加宽、文案改为“重选目录”
5. 用户点击“重选目录”后回到目录选择页，必须选择其他安装目录才能继续安装
6. 用户仍可取消安装器退出；不提供“忽略并继续”入口
7. 静默安装命中 `.zcode` 时直接退出失败，避免自动化安装绕过数据保护

该阻断保护只面向安装包流程，不替代设置页的数据迁移校验。

## UI 交互流程

1. 只读路径框默认显示当前生效路径（已配置的路径或 homedir）
2. 点击「选择文件夹」，通过系统目录弹窗选择新的根目录
3. 确认无误后点击「保存」
4. 按钮显示加载动画，选择按钮禁用，提示"正在复制数据，请勿关闭应用…"
5. 复制完成 → 提示"数据已保存，重启应用后生效。"
6. 复制失败 → 提示"数据复制失败，路径未更改。"（红色），可重新选择后重试
7. Windows 上若选择了 ZCode 安装目录或其子目录 → 提示"不能选择 ZCode 安装目录作为数据存储路径"，路径不写入配置
8. 用户重启应用后新路径生效

## 已确认的迁移边界

用户于 2026-08-10 确认以下目标语义：

1. App `.zcode/v2` 与非项目对话 `.zcode/workspace` 一并迁移。
2. 只允许在当前 conversation 已空闲时发起迁移。
3. 保存成功后进入待重启状态；目标产品态应阻止继续向旧 App 数据目录写入。
4. 目标目录已有 ZCode 数据时拒绝迁移，不做逐文件或 SQLite 合并。
5. 完整冷重启后，迁移前任务历史仍可见，并且可以在同一任务中继续对话。
6. `dataBaseDir` 只改变 App 数据目录；CLI 用户资源仍使用 `<HOME>/.zcode/cli`，项目内
   `.zcode/*` 也保持原路径。

首个自动化 case `CDD01` 暂不修改上述产品行为，只验证当前可安全执行的代表路径：Desktop
本地 `desktop-continuous`、任务已空闲、目标目录为空、保存后不再执行任何业务操作并立即完整
重启 Electron、Host 与 Agent。

```text
old App root + idle task
          |
          | choose empty target + save
          v
restart-required UI
          |
          | no more writes in the old process
          | immediate full cold restart
          v
new App root
          +--> old task history is visible
          +--> same task accepts a follow-up
          +--> App task-index writes stay under the new root
          +--> CLI stays under <HOME>/.zcode/cli
```

`CDD01` 的 idle 与立即重启是测试前置/时序约束，不代表当前产品已经机械阻止 busy 迁移或保存后的
继续写入；非空目标拒绝也不由该 case 证明。当前 `copyDataDirectory()` 只复制 `.zcode/v2`，尚未
实现本 spec 要求的 `.zcode/workspace` 迁移，因此 workspace 断言单独记录为 bug candidate，不能
把 `CDD01` 的通过解释为完整满足第 1 条。

## 相关代码

| 文件 | 职责 |
|------|------|
| `packages/services/src/paths.ts` | `setDataBaseDir` / `getDataBaseDir` / `getAppConfigDir` / `copyDataDirectory` / Windows 安装目录校验 |
| `packages/services/src/setting/settingService.ts` | `updateDataBaseDir()` — 校验 + 复制 + 持久化 |
| `packages/services/src/setting/setting.ts` | `ISettingService` 接口定义 |
| `packages/shared/src/protocol.ts` | `AppSettings.dataBaseDir` 类型 |
| `packages/shared/src/validation.ts` | zod schema |
| `packages/desktop/build/installer.nsh` | Windows 安装器在写入文件前阻断安装目录内已有 `.zcode` 的安装 |
| `packages/desktop/src/main/index.ts` | 主进程 bootstrap 读取 |
| `packages/desktop/src/main/desktopRuntimeEnv.ts` | `buildHostProcessEnv` 传递环境变量 |
| `packages/ui/src/settingsPageHelpers.tsx` | UI 输入框 + 保存状态管理 |
| `packages/ui/src/SettingsPage.tsx` | 页面级状态 + 服务调用 |
