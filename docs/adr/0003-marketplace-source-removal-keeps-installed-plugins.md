# 删除 Marketplace Source 时保留已安装插件

- 状态：Accepted
- 日期：2026-07-15

## Context

Personal Source 同时承担“可发现目录”和“未来更新来源”，但已安装插件已经复制到用户级
插件存储，并可能拥有配置、启停状态和数据。删除来源若隐式级联卸载，会把一个看似只管理
目录的操作变成破坏性数据删除；若完全隐藏插件，又会让磁盘中的有效安装失去管理入口。

## Decision

删除 Personal Source 只删除 marketplace 记录和目录投影，不删除安装、配置、启停状态、
缓存或插件数据。仍存在的安装进入 `Orphaned Installed Plugin` 状态：

```text
source present + installed
           |
           | remove source
           v
orphaned installed -------------------+
  | use/configure/enable/disable       |
  | uninstall                          | re-add same source
  | update unavailable                 |
  +------------------------------------+
                       source-associated installed
```

孤立插件继续出现在 Installed Strip、详情和 Manage Installed View。UI 必须诚实展示来源缺失，
且来源重新添加前不得执行更新。重新添加同一 marketplace id/source 后重新关联当前安装，恢复
listing 和更新能力；不能自动改写用户配置或 enabled 状态。

## Consequences

- 来源删除成为可逆的目录管理操作，不会造成隐式数据丢失。
- 安装状态和来源状态必须独立建模，UI 不能以“目录中不存在”推导“未安装”。
- 更新检测需要来源存在；孤立状态下只能使用当前安装版本。
- 用户仍可从管理页显式卸载孤立插件，并按普通卸载规则清理数据。
- Lifecycle E2E 必须覆盖来源删除、孤立状态、继续使用、重新关联和显式卸载路径。
