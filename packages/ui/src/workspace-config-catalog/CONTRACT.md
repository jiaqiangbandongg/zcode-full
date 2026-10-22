# 配置目录目录表

项目服务拥有 roots，Catalog 只读项目与仍保留的远端入口，按 workspace identity/path 去重，不从 tab 或旧 settings 集合推导目录成员。不读取任务、不创建项目/Agent/连接，未打开 tab 的 root 可配置。

请求前后校验 Host membership 与入口 ID，丢弃删除/重加后的迟到远端结果。UI 只持有读取结果与加载状态；state:projects 通知触发重读。读取失败不沿用另一 Host 的配置目标。

Desktop 远端配置复用已有 Source settings attachment；仅在选中远端且无 logical attachment 时请求它。手机继续使用可信 shared-host workspace attachment，不能借此请求 Source settings 或启动独立 Host。配置 hooks 与 conversation hooks 分开，后者不能获得配置专用服务集合。

模块依赖既有 UI 的 tab 类型、workspace hooks、配置 attachment store 与 logger；这些是适配入口，不新增目录事实源。
