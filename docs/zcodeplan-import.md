# ZCode Plan 源码附加说明

## 来源

- 来源仓库：内部仓库 `zcode/zcode-server`
- 来源分支：`main`
- 来源提交：`b29f7bf78388d137bdf078bb644963bee611c80c`
- 来源目录：`internal/application/zcodeplan`
- 本项目落点：`code/zcodeplan`

## 边界

`code/zcodeplan` 保留原 `zcode-server` 的 Go package 和内部 import 路径，用于后续对照、迁移或实现 off-peak task / plan 相关能力。

当前变更只把来源目录附加到本项目，不把这批 Go 代码接入本仓库构建、运行时或 UI 流程。
