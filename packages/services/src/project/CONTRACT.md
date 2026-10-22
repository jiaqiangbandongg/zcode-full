# Host 项目服务

唯一写者是当前 Host 的 tasks-index 存储。服务负责真实目录校验、默认目录创建与旧设置双写；自动归档由本模块的定时扫描器执行（启动首轮、每小时、设置变更补扫），不挂在任何读取或 UI 动作上；Repository 在事务内维护项目、roots 与任务归属。UI 只经 hooks 调用此契约。远程调用使用拥有组织态的现有 Host attachment，不让 main/relay 创建业务副本。

目录解析的 task 归属与 roots 来自同一读快照。已知 task 无项目时返回空附加目录；引用悬空项目或读取失败直接拒绝。prepareSession 的 cwd 创建后固定；编辑 roots 只影响下一次 runtime materialization。删除项目不删除会话；移动不写 CLI 事实、时间或 cwd。CLI continuous/replayable 流不由本模块修改。

全局创建显式空归属，不按目录猜项目。跨 host 移动失败；同 host 缺目录时先返回错误，用户明确确认后原子追加 root 与移动。可删除容器永久保留，恢复仅由新建时明确选择同 roots 的已删项目。

远端装配器在 prepareSession 和 resolveSessionDirectories 后，通过既有 workspace identity resolver 为返回的真实 cwd 登记并返回 workspaceIdentity；不复制请求中的身份，resolver 失败直接拒绝。readTree 返回前对全部项目 roots（包括无任务的空项目）与历史任务 cwd 去重并完成同一身份准备，失败不发布树，防止侧栏动态订阅落到未映射的事件源。它只提供导航/隔离身份，不改 cwd 和附加目录；UI 不得从远端真实路径推断本机 workspace。导航继续严格比较任务与目录解析结果的 cwd 和身份，不以路径相同绕过设备隔离。

readProjects 只查询项目/roots，不加载任务或触发 Agent，用于目录管理；readTree 同样只读，两者都不触发自动归档。旧 settings 集合由本机提交的项目/入口派生；窗口只写 lastActiveWorkspace。派生端口不得调用 settings 或网络，设置文件锁内重读，防止删除入口被迟到响应复活。

缺少 virtualProjects 握手能力的远端只使用单 root 读适配器。它读取远端旧 app 数据，不写本机项目，不启动 Agent，项目组织操作显式拒绝；创建/恢复只返回既有 cwd 与空附加目录。合成 ID 由 host/cwd 稳定导出，升级时只允许入口的版本 CAS 解析，不形成持久权威项目。

旧单 root 投影的 `directoryMatchPath` 按远端 platform 与 readDirectory 的同一 normalize 规则派生，只用于目录匹配。原 root、合成 ID、任务 cwd 与归属保持不变，该值不落库或写入口缓存；等价目录的多个历史 ID 不合并。

readDirectory 是项目选目录的 Host 路由入口：未指定 path 返回所属 Host 的 home，指定 path 沿所属 Host 的项目保存规则 normalize 后复用文件服务 readdir，返回规范化 path 与目录条目，不增加 realpath 或符号链接等价规则。旧远端同样通过已连接设备的 systemService.info 与 fileService.readdir 浏览和验证；路径判定与规范化明确采用远端 platform 对应规则，仍禁止项目新建和组织写入。目录端口由装配层注入；失败拒绝，不新建目录/项目/会话。不依赖桌面平台接口，手机使用同一 RPC。

主目录可用性见 `docs/project-primary-root-availability.md`：所属 Host 在 readTree/readProjects 中异步探测主目录，返回可选 primaryRootStatus，不写库、不持久缓存；prepareSession 再次检查，失效直接拒绝，不复活或替换 cwd。侧栏消费同一投影置灰标题并禁用新建入口，标题仍可展开已有任务并读取历史，focus 刷新沿用请求序号；空项目与附加目录失效不误禁用，远端仅经已有 owner attachment 检查。

## 2026-10-10 远程单目录合同

本地仍允许 0..n roots；可信 ownerHostId 非 local 的持库宿主只允许恰好一个固定 root。远程创建必须有项目，prepareSession、reserveCreatedTask 与 moveTask 不得产生无归属或附加目录；根路径更新和缺 root 拖动在写事务中拒绝。客户端 hostId 不能改变持库身份。历史迁移数据不被裁剪，失败不得部分写入。

未归类 Composer 可传 UUID draftId，目录由 Host 在 workspaceDirectory 下确定性派生；并发和重试只准备同一目录。reuseDraft 表示客户端已拿到该目录，缺失时报错，不重新 mkdir。无 draftId 的其他调用保持独立分配，远端仍要求项目；草稿和接纳记录不进入项目数据库。
