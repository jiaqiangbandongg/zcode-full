# ZCode Feedback Tickets Skill Spec

## 目标

新增工作区 skill `zcode-feedback-tickets`，用于让 Agent 通过 ZCode 反馈工单 Agent 接口安全地查询、读取、更新和闭环反馈工单。

## 来源

接口契约来自飞书文档《ZCode 反馈工单 Agent 接口 Skill》，文档地址：

`https://internal-docs.example.invalid/redacted`

## Skill 位置

放在项目级 skill 目录：

`/.agents/skills/zcode-feedback-tickets`

选择项目级目录而不是全局目录，是因为该 skill 绑定 ZCode 反馈工单域名、状态流转和项目处理流程，应该随 z-code 工作区加载。

## 触发范围

当用户要求处理 ZCode 反馈工单、反馈平台、工单号 `ZCT-...`、读取工单上下文、下载资料包、更新工单进度、解决工单、转单、批量归档/评论/拒绝/关闭时触发。

## 关键约束

- 默认使用 `ZCODE_FEEDBACK_BASE_URL`，未设置时回退到 `https://feedback.example.invalid`。
- 管理接口认证使用 `Authorization: Bearer $ZCODE_FEEDBACK_ADMIN_JWT`。
- 若 token 不存在，走设备授权流程，不要伪造 token。
- 写操作前先读取工单上下文，确认工单号、状态和用户意图。
- 危险操作 `delete` 必须用户明确要求才可执行。
- 批量接口返回后必须检查 `skipped`，不能只看 `affected`。
- 开发完成使用 `已解决`，不要使用旧状态 `等待上线`。
- 不在最终回复里泄露 JWT、设备码或敏感附件内容。

## 内容结构

- `SKILL.md`：核心流程、认证前置、安全边界和常用命令入口。
- `references/api.md`：从飞书文档整理出的接口清单、参数、状态和 curl 示例。

## 验证

创建完成后执行 skill 校验脚本：

```bash
python3 /Users/dev/.codex/skills/.system/skill-creator/scripts/quick_validate.py .agents/skills/zcode-feedback-tickets
```
