# 08 · Skills 与自定义命令

Skill 是按需加载的任务说明；它不会自动增加操作系统权限。技能中的命令仍受当前工具、权限和运行环境约束。

## 编写一个技能

在项目中创建 `.agents/skills/greet/SKILL.md`：

```markdown
---
name: greet
description: 用户要求问候时使用，用一句话问候。
---

请用一句话问候用户，并在末尾加上 READY。
```

当前默认发现路径包括用户及项目的 `.zcode/skills` 和 `.agents/skills`。Git 工作区中会向工作树根查找技能目录；同级 `.zcode` 优先于 `.agents`。启用的插件也可贡献技能。重复名称和 metadata 预算会影响最终可见集合，使用清单核对来源：

```sh
zcode skills list --cwd /absolute/path/to/project --json
zcode commands list --cwd /absolute/path/to/project --json
```

`skills.roots` 可以增加技能根目录。运行配置中的 `features.skill`、`skills.enabled`、插件启用态以及单项覆盖都会影响结果。修改后用新进程验证；不要把磁盘上有 SKILL.md 当成已加载。

## 调用与自定义命令

普通 prompt 可以描述任务，让模型按技能说明使用；显式调用格式及命令是否存在，以 `commands list`、`skills list` 和对应构建的帮助为准。插件中的 `commands/hello.md` 可定义自定义斜杠命令：

```markdown
---
description: 简短问候
argument-hint: "[名字]"
---

请对 $ARGUMENTS 说一句问候。
```

插件加载后可用 `zcode --prompt "/hello reader"`。自定义命令会展开为指令参与模型调用，不应与 `/help` 等本地返回命令的输出混为一谈。

批量任务应固定技能版本和启用清单。需要无技能对照组时，同时检查用户目录、项目目录与插件贡献，避免开发机环境污染结果。
