# 远程项目连接详情

SSH 专用 tooltip 已由统一远程项目详情替代；当前合同见 [平铺项目导航 · RDUX-12](../remote/project-first-remote-navigation-spec.md#21a-侧栏详情与设备菜单rdux-12)。SSH、WSL、Docker、Direct Server 共用同一展示模型。

- 设备标签点击立即打开可操作详情，悬停 400ms 打开同一个浮层。锚定项目整行右侧，Escape、外部点击或移出未固定详情后关闭；菜单关闭不残留提示。
- 详情显示项目名、设备名、连接描述、完整远端路径、状态及原因，不显示密码、私钥路径、passphrase 或 URL token。会话头部名称与路径与此一致。
- 连接沿用原项目目录意图；断开作用于设备；编辑复用连接编辑框；管理进入设置并一次性滚动、聚焦目标设备卡。
- 展示名不参与排序、去重或 workspace identity 计算；浮层属于 UI，不改变 task、snapshot、queue、owner 或 desktop continuous / mobile replayable 链路。
