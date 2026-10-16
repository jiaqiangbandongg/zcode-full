# 上游 v3.15.1 同步

## 范围与规则

将上游 `aac47556` 与 fork `99010c3e` 合并，保留双方提交历史。
保留 fork 的 Git 备份实现、`/backup` 命令及中英文文案，同时接纳上游新增命令、
Highspeed 文案和构建期可选能力。不引入新的状态所有者或业务写入路径。

遥测开关与上报端点由 shared env 模块统一解释，规则见
`docs/desktop/build-time-optional-capabilities.md` 的 Fork 同步兼容约束。

Web 分享页继续从 `@zcode/shared` 的公开 exports 解析包根和子路径，
Vite 配置不得把子路径拼到 `src/index.ts` 文件后。通过实际生产构建验证。

## 验收

- 四个冲突文件无冲突标记；上游命令与 fork backup 命令共存且名称不重复。
- Git 备份和 Highspeed 的中英文键、插值参数对应。
- 已注入上报端点时，显式关闭遥测仍使两个有效端点为空；自动更新不受影响。
- 执行类型检查、lint、架构检查、相关单测和构建；如有上游或环境失败如实记录。
- 将验证后的结果更新到现有同步 PR，主分支合入另行决定。
