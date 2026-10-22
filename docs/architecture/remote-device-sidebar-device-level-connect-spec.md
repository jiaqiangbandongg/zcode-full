# 设备上线后的工作区恢复入口

旧侧栏设备组头与 connect-and-chat UI 已由[平铺项目导航](../remote/project-first-remote-navigation-spec.md)替代。
带目录入口恢复原项目，无目录的手动连接成功后选目录；需凭据、安装或升级时交接唯一向导，保留原意图。
展示只依赖[统一五态](remote-device-connection-ux-spec.md)，不再维护旧四态或 pending→离线规则。

## C3 设备上线恢复门禁

本项有效规则已集中到 [Renderer 重挂](../remote/desktop-remote-session-renderer-reattach.md)：
Host 冷启动按设备最近 7 天 `lastOnlineAt` 选择静默连接候选；设备 online 后，Renderer 挂回当前窗口
该 Source 下全部 open、断连且 stable identity 的项目，不再次按 workspace 年龄或上次 connected 状态过滤。
同周期去重、terminal close、主动断开与迟到结果边界均由该规格维护。

历史 RDUX-12/13/14 是原设备组头回归编号，不等同于后来同号的 UX 实施票；保留原记录，
不得用旧 connect-and-chat 断言替代当前导航验收。原根因日志、改动清单和测试记录：

```bash
git show a17a875588b8d66c2bee49236292e174df651363:docs/architecture/remote-device-sidebar-device-level-connect-spec.md
```

本次仅收敛文档，不改变 Host 门禁、数据格式或 desktop continuous / mobile replayable 语义。
