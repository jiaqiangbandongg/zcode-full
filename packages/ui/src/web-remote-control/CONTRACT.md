# web-remote-control-ui

展示桌面远控状态、设备导航，并转发 OAuth 完成事件。

宽窄屏共用 TaskViewReporter，从已提交的完整任务导航、实际聊天表面与 Page Visibility 派生查看声明；首页、草稿、后台、遮盖与卸载清空声明。查看 Reporter 和手机 Home/chat 状态由稳定的 Shell 持有，断点变化只替换布局内容；初始聊天意图不随断点重复执行。最后导航位置与瞬时查看分开，不保存另一份导航，也不写任务未读。Main 校验连接与 bridge 后交给桌面唯一 writer。详见 [任务列表刷新语义](../../../../docs/task-list-refresh-semantics.md)。

dialog 只保留 UI 投影；Main 重读凭据，OAuth 服务是认证唯一事实源。身份比较必须同时检查 workspaceKey 与 remoteSessionId。弹窗经 index 暴露，设备 header 与 auth hook 是独立入口，避免引入无关 UI。

完整语义见 [Relay V2 spec](../../../../docs/web-remote-control/relay-v2-pairing.md)。
