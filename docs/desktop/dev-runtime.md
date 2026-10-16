# Desktop 开发运行时目录

## 规则与所有者

- macOS 开发启动脚本 `packages/desktop/scripts/dev.mjs` 指定仓库根目录下的
  `.zcode-runtime/desktop-dev` 为 Electron 开发副本目录。
- `prepareDevElectronAppBundle` 通过现有 `runtimeRoot` 参数接收目录，并负责创建、
  校验和复用 `<Electron 版本>-<架构>/ZCode Dev.app`。
- 副本保留现有应用身份与 `zcode` 协议声明；Windows、Linux 和打包版本的启动逻辑不变。
- `.zcode-runtime/` 是可重建的本地产物，必须由 `.gitignore` 忽略。

## 切换与失败边界

启动脚本只使用新目录，不自动迁移或删除旧缓存。新目录不存在时，现有准备函数创建
副本；创建失败时沿用现有错误传播行为，不回退到旧目录。

## 验收

1. 启动脚本传入的目录与 `.gitignore` 中的目录一致。
2. 路径仍按 Electron 版本和架构隔离，准备函数的缓存复用和协议声明逻辑不变。
3. 通过脚本语法检查、类型检查、Lint 和架构检查。
