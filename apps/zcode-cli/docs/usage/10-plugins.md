# 10 · Plugins

插件用于分发技能、自定义命令、Hook 和 MCP 等扩展。CLI 支持安装和市场管理，不再限于本地目录。插件数量、版本和默认启用状态会变化，以清单为准。

## 常用命令

```sh
zcode plugins list --json
zcode plugins list --available --json
zcode plugins marketplace list --json
zcode plugins marketplace add /absolute/path/to/marketplace
zcode plugins install example-plugin@example-market --scope user
zcode plugins enable example-plugin@example-market
zcode plugins disable example-plugin@example-market
zcode plugins update example-plugin@example-market
zcode plugins uninstall example-plugin@example-market --keep-data
zcode plugins marketplace update example-market
zcode plugins marketplace remove example-market
```

示例市场和插件须先存在。`--scope` 支持 `user` 和 `project`；修改项目启用配置时指定对应工作目录。安装、启用、更新和卸载是不同操作，完成后重新查看清单，并用新进程验证。

`plugins list` 可以独立触发内置插件准备，无需先运行一次模型对话。全局关闭插件、缺少资源或准备失败也可能导致列表为空；先看诊断，不要用付费 prompt 作为初始化步骤。

## 本地插件

```text
example-plugin/
  .zcode-plugin/plugin.json
  skills/greet/SKILL.md
  commands/hello.md
```

manifest 示例：

```json
{
  "name": "example-plugin",
  "version": "0.1.0",
  "description": "示例技能与命令",
  "skills": "skills",
  "commands": "commands"
}
```

技能和命令内容见[Skills](08-skills.md)。运行配置启用本地目录：

```json
{
  "plugins": {
    "enabled": true,
    "dirs": ["/absolute/path/to/example-plugin"]
  }
}
```

验证：

```sh
zcode plugins validate /absolute/path/to/example-plugin --json
zcode plugins list --json
zcode skills list --json
zcode commands list --json
```

插件可携带本地可执行内容。安装前审查其 Hook、MCP 命令、依赖和数据访问范围。validate 只检查结构与诊断，不证明插件安全或所有功能可用。兼容 manifest 中的字段也不一定具有运行时实现；以加载诊断为准。

## 数据与复现

默认目录为 `~/.zcode/cli/plugins/`：市场索引、安装记录、`cache/` 中的版本内容，以及 `data/` 中的持久数据分别管理。启用态还保存在运行配置中。只复制缓存不能完整恢复安装和启用状态。

插件需要持久写入时使用插件数据目录，不要改插件代码目录。卸载前确认是否保留数据，批量实验固定版本并归档非敏感清单。不要在比较实验中自动更新市场或插件。
