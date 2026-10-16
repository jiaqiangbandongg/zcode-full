import { describe, expect, it } from "vitest";
import enUS from "@/i18n/locales/en-US.js";
import zhCN from "@/i18n/locales/zh-CN.js";

const stableKinds = {
  "chat.toolCall.kind.read": ["读取", "Read"],
  "chat.toolCall.kind.search": ["搜索", "Search"],
  "chat.toolCall.kind.write": ["写入", "Write"],
  "chat.toolCall.kind.edit": ["编辑", "Edit"],
  "chat.toolCall.kind.delete": ["删除", "Delete"],
  "chat.toolCall.kind.terminal": ["终端", "Terminal"],
  "chat.toolCall.kind.skill": ["技能", "Skill"],
  "chat.toolCall.kind.sessionContext": ["会话上下文", "Session context"],
  "chat.toolCall.kind.nodeRepl": ["Node.js", "Node.js"],
  "chat.toolCall.kind.message": ["消息", "Message"],
  "chat.toolCall.kind.response": ["回复", "Response"],
  "chat.toolCall.kind.taskOutput": ["任务输出", "Task output"],
  "chat.toolCall.kind.taskStop": ["停止任务", "Stop task"],
  "chat.toolCall.kind.todo": ["待办", "Todos"],
  "chat.toolCall.explore.label": ["查阅", "Explore"],
} as const;

const runningActions = {
  "chat.toolCall.edit.writing": ["正在写入", "Writing"],
  "chat.toolCall.edit.editing": ["正在编辑", "Editing"],
  "chat.toolCall.edit.deleting": ["正在删除", "Deleting"],
  "chat.toolCall.execute.running": ["正在执行", "Running"],
  "chat.toolCall.skill.running": ["正在运行技能", "Running skill"],
  "chat.toolCall.search.searching": ["正在搜索", "Searching"],
  "chat.toolCall.read.reading": ["正在读取", "Reading"],
  "chat.toolCall.sessionContext.reading": ["正在读取上下文", "Reading context"],
  "chat.toolCall.nodeRepl.processing": ["正在执行代码", "Working"],
  "chat.toolCall.sendMessage.sending": ["正在发送消息", "Sending"],
  "chat.toolCall.respondToCoordinator.replying": ["正在回复", "Replying"],
  "chat.toolCall.taskOutput.fetching": ["正在获取任务输出", "Fetching output"],
  "chat.toolCall.taskStop.stopping": ["正在停止任务", "Stopping"],
  "chat.toolCall.todo.updating": ["正在更新待办", "Updating todos"],
} as const;

describe("tool call presentation vocabulary", () => {
  it.each(Object.entries(stableKinds))("defines stable kind %s", (key, [zh, en]) => {
    expect(zhCN[key]).toBe(zh);
    expect(enUS[key]).toBe(en);
  });

  it.each(Object.entries(runningActions))("uses an active action for %s", (key, [zh, en]) => {
    expect(zhCN[key]).toBe(zh);
    expect(enUS[key]).toBe(en);
  });
});
