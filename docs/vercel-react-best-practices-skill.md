# Vercel React Best Practices Skill

## 背景

项目级 Agent skills 目录新增 Vercel 官方 `react-best-practices` skill，用于在编写、审查或重构 React / Next.js 代码时引用 Vercel 的性能优化规则。

## 来源

- 仓库：`vercel-labs/agent-skills`
- 路径：`skills/react-best-practices`
- Skill 名称：`vercel-react-best-practices`

## 安装位置

安装到项目内：

```text
.agents/skills/react-best-practices
```

这样该 skill 随项目版本管理，不依赖单个开发者的全局 `~/.codex/skills`。

## 使用边界

- 适用于 React 组件、Next.js 页面、数据请求、bundle 优化、渲染性能和重渲染优化相关任务。
- 修改 `packages/ui` 代码时，仍必须优先遵守项目根目录 `DESIGN.md` 与当前 `AGENTS.md` 中的 UI、日志、国际化、多端兼容约束。
- 该 skill 只提供 React / Next.js 性能实践参考，不替代项目架构边界、远控链路、Workspace Identity 等项目级约束。
