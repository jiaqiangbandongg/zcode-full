# Skill / Command 可用性覆盖（config.json）

## 目标

允许通过 `config.json` 按**绝对路径**禁用单个 skill 或自定义命令，被禁用项在发现阶段直接剔除，
agent 看到的「真实可用」集合即过滤后的结果。

## 配置格式

key 为对应 `.md` 文件的绝对路径（skill 用 `SKILL.md`，命令用命令 `.md`）：

```json
{
  "skill": {
    "/Users/me/.zcode/skills/demo/SKILL.md": { "enable": false }
  },
  "command": {
    "/Users/me/.zcode/commands/demo.md": { "enable": false }
  }
}
```

语义：

- 只有显式 `"enable": false` 的条目被过滤。
- **未列出的条目默认可用**（`enable` 缺省视为 true）。
- 走统一 config 管道，任意 scope（user `~/.zcode/cli/config.json`、project `.zcode/config.json` 等）
  都可写；多 scope 按路径 key 合并，高优先级覆盖低优先级。

## 实现链路

1. **schema**（`packages/adapters/src/config/schema.ts`）：`ZCodeConfigFileSchema` 新增 `skill` /
   `command` 两个 `Record<path, { enable?: boolean }>` 字段，`parseConfigFileToRuntimePatch`
   映射到 patch 的 `skillOverrides` / `commandOverrides`。
2. **contracts**（`packages/contracts/src/config/index.ts`）：新增 `ConfigKey.SkillOverrides="skill"` /
   `CommandOverrides="command"`、`RuntimeConfig.skillOverrides` / `commandOverrides`（默认 `{}`）。
3. **store**（`packages/adapters/src/config/index.ts`、`config-merger.ts`）：merge 写入 store、
   `getRuntimeConfig` 组装、跨 scope 按 key 深合并。
4. **adapter 过滤**（`packages/adapters/src/skills/index.ts`、`commands/index.ts`）：新增
   `disabledPaths` 选项，`discoverSkills` / `discoverCommands` 解析后命中即跳过。因为 `loadSkill` /
   `loadCommand` / inspect 都复用 discover，过滤对全链路一致。
5. **bootstrap**（`packages/bootstrap/src/skills.ts`、`custom-commands.ts`）：从
   `config.skillOverrides` / `commandOverrides` 取出 `enable:false` 的路径集合传入 adapter。

## 测试

- `packages/adapters/tests/config.test.ts`：JSON `skill`/`command` 字段映射到 runtime override。
- `packages/adapters/tests/skills.test.ts`、`commands.test.ts`：`disabledPaths` 过滤掉对应项，
  且被禁用项 `load*` 抛 not found。
