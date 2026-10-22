# 项目主目录失效时的侧栏状态

## 行为

项目已配置的主要目录被删除、移动或变为普通文件时，项目标题保留置灰提示，但仍可用鼠标、键盘和触屏展开/收起已有任务并查看历史消息；行内「新建任务」和「查看文件」按钮显示禁用态，不能创建草稿或打开文件树。仅两个按钮 hover 提示：**该项目主文件夹已被删除或移动**；项目行和标题 hover 或聚焦不显示目录失效提示。右键菜单的新建任务和所有「查看文件」条目同样禁用。单 root 直接入口、多 root 目录菜单使用相同规则；主目录失效时，附加目录仍存在也不能从项目打开文件树。

项目仍留在侧栏，未读点保留，编辑/删除/置顶入口继续可用，用户可以编辑源文件夹。缺少附加目录不禁用项目；零 root 项目仍可新建，由 Host 按既有规则分配默认目录。既有任务的 cwd、归属、正文和启动恢复策略不因本功能改变。

## 状态与归属

```text
项目列表首次读取 / 项目变更 / 窗口 focus
  → 所属 Host ProjectService 读取项目快照
  → 按主目录去重，异步 stat
  → VirtualProject.primaryRootStatus 只读投影
  → 侧栏接受最新请求的结果
      available / 无字段 → 正常入口
      missing            → 标题置灰但可展开；禁止新建/查看文件 + 删除或移动提示
      unavailable        → 标题置灰但可展开；禁止新建/查看文件 + 无法访问提示

标题展开 → 原折叠偏好 owner → 原任务行与历史消息读取（不依赖主目录存在）
新建请求 → 同一 Host prepareSession 再检查主目录 → 可用才返回 cwd
```

- `primaryRootStatus` 为可选的 `available | missing | unavailable`，由目录所属 Host 实时派生，不写 SQLite/settings/远端入口缓存，不引入 migration。旧 Server 未返回该字段时保留旧行为。
- `ENOENT`、`ENOTDIR`、路径存在但不是目录视为 missing；其他 stat 失败为 unavailable，不误报目录被删除。
- 无主要目录的零 root 项目不标为 missing；已配置主目录失效时不能重新 mkdir 原路径、改选附加目录或回退为全局任务。
- 每次 readTree/readProjects 重新检查，不永久缓存、不轮询。目录恢复或编辑主目录后，下次刷新恢复入口。UI 在 focus 时刷新，沿用请求序号丢弃迟到响应。
- prepareSession 在返回 cwd 前复检，拒绝刷新与点击之间的失效；失败不改项目 roots 或既有任务。文件系统在最终检查后的变化仍由实际执行入口报错。
- 远端目录只由已有 remote Host attachment 检查，不在本机 stat 远端路径，不创建连接/Host/Agent。手机 shared-host 读取同一状态，桌面 continuous 和手机 replayable 的消息流边界保持原样。
- 明暗主题下标题沿用原弱化程度但不设置目录失效的 disabled/aria-disabled；按钮本身承接键盘焦点，避免重复焦点。新建和查看文件按钮保持禁用语义。远端 Host 离线仍遵守原不可展开约束。
- 主目录存在性限制新建与查看文件；折叠状态仍由原侧栏偏好 owner 持有，失效和恢复不强制收起。历史点击复用原任务选择/只读恢复链路，不修改 cwd，不为只读浏览重建目录。

## 验收

1. 单/双 root 项目的主目录移走后：标题置灰但可展开/收起并打开真实历史消息，行内/右键的新建与查看文件禁用，准确提示；附加目录仍在时也不能打开文件树或新建，编辑入口可用。
2. 目录移回后 focus 刷新恢复；仅附加目录缺失、空项目均不触发主目录禁用。
3. 真实 Host 单测验证 missing/普通文件/恢复、prepareSession 复检与无副作用；远端路由不在本机探测路径。
4. pending E2E `conversation-session-project-missing-primary-root.test.ts` 覆盖真实目录移走/恢复、窗口刷新、hover、上下文菜单、明暗主题和窄布局；窄布局不等同于实际手机 shared-host 验证。
