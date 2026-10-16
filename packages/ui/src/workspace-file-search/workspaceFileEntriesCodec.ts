// 实现已上移 @zcode/shared/workspaceFileEntriesCodec（services/Host 侧也要使用，
// 分层上不能再留在 ui 包）。本文件保留为转发出口：workspaceFileSearchFilterBackend
// 与 worker 的历史 import 路径继续可用，也避免 git diff 呈现"删除代码文件"
// 触发 pre-push affected 的全量回退。
export * from "@zcode/shared/workspaceFileEntriesCodec";
