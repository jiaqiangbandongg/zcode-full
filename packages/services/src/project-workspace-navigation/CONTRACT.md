# 项目 workspace 导航 admission

唯一目录 owner 是 ProjectService，唯一远端连接与 logical scope owner 是窗口 Registry / SourceManager。导航只组合现有端口，不缓存项目/任务事实，不拥有 Agent 或 accepted queue。

本地 prepare 直接返回既有目录解析结果；远端只接受本机保留的 host、仍可用的入口以及在线物理 owner。prepare 前后检查 membershipId、入口 ID 与 owner；Registry 在提交 provisional scope 前再次执行同一检查，失败只回收该次 provisional scope，不关闭被其他窗口/手机/桌面共享的 owner。

输入只有 projectId 与 hostId，不接受手机传入 cwd、identity 或 remoteSessionId。成功返回 Host 目录结果与 Registry 生成的脱敏 descriptor。main 只转交 descriptor，手机仍使用 web-remote-replayable 的现有 shared-host attachment。桌面 continuous 不经过此手机分支。

导航请求重试去重与替换归通信请求生命周期；不得在本模块创建第二份业务状态。离线、入口移除或物理换代均失败，绝不隐式 reconnect 或从旧 settings 复活连接。

Existing task navigation validates taskId/workspaceKey against the authority tree, then resolves its original directories. It never calls prepareSession or creates a replacement cwd. Remote membership and physical-owner checks also cover this path.

本地未归类草稿导航还接受可选 draftId（UUID）与 reuseDraft；由 ProjectService 校验和准备。与 projectId/task 互斥，不接受客户端自行指定目录；目录的待发送身份与首发消费仍归客户端现有命令恢复链路。
