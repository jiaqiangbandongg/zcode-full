# Conversation workspace 目标解析

模块组合 Root 提供的操作端口，解析“在项目外工作”的目录和身份。窗口 tab store 是 tab 的唯一 owner，Registry / SourceManager 是远程连接和 Source 归属的唯一 owner；解析器只读取事实，不保存副本。

远端不能解除项目绑定，直接拒绝无项目目标。路径相同不能代表设备相同；Source 解析只消费持久化 alias，含糊结果不猜。workbenchTarget 仅解析分屏焦点，最终创建仍交给 ProjectService 按显式项目准入。本地继续使用既有目录解析端口。调用方只使用公开入口和契约。

修复原因：原解析文件落在未受管的 ui 模块，阻塞 pre-push。现在用独立 app 层承载端口编排，契约采用最小只读 tab 视图，避免反向依赖 Root / Zustand。

此模块不改变桌面 continuous、手机 replayable/shared-host、连接重用或持久化边界；具体打开行为与重试语义继续由注入端口负责。

插件创建菜单和控制器复用 workbenchTarget 解析焦点项目；设置菜单只发起同一创建命令，预填在目标会话成功创建后消费，不持有第二份项目状态。
