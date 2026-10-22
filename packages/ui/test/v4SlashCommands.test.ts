import { describe, expect, it } from "vitest";
import {
  parseSelectionSideSlashCommand,
  parseV4VisibleSlashCommand,
  v4QueuedCommandText,
} from "@/v4/slashCommands.js";

describe("parseV4VisibleSlashCommand", () => {
  it("parses /goal and /target into a goal command objective", () => {
    expect(parseV4VisibleSlashCommand("/goal 修复登录", [])).toMatchObject({
      kind: "sendGoalCommand",
      objective: "修复登录",
      displayText: "/goal 修复登录",
    });
    expect(parseV4VisibleSlashCommand("  /target 修复登录  ", [])).toMatchObject({
      kind: "sendGoalCommand",
      objective: "修复登录",
      displayText: "/target 修复登录",
    });
  });

  it("strips /goal replace from the objective but preserves display text", () => {
    expect(parseV4VisibleSlashCommand("/goal replace 新目标", [])).toMatchObject({
      kind: "sendGoalCommand",
      objective: "新目标",
      displayText: "/goal replace 新目标",
    });
  });

  it("maps the CLI /goal resume syntax to resumeGoal", () => {
    expect(parseV4VisibleSlashCommand("/goal resume", [])).toEqual({
      kind: "resumeGoal",
      displayText: "/goal resume",
    });
  });

  it("does not consume the removed UI-only /resume-goal alias", () => {
    expect(parseV4VisibleSlashCommand("/resume-goal", [])).toBeNull();
    expect(parseV4VisibleSlashCommand("/resumegoal", [])).toBeNull();
  });

  it("does not consume commands with attachments", () => {
    expect(
      parseV4VisibleSlashCommand("/goal 修复登录", [
        { ref: "zcode-artifact://a", fileName: "a.txt", mime: "text/plain", bytes: 1 },
      ]),
    ).toBeNull();
  });

  it.each(["/plan", "  /PLAN  帮我做 X  ", "/planner 做普通任务"])(
    "does not interpret %s as a send-time command",
    (text) => {
      expect(parseV4VisibleSlashCommand(text)).toBeNull();
      expect(parseV4VisibleSlashCommand(text, [{ ref: "zcode-artifact://a" }])).toBeNull();
      expect(parseV4VisibleSlashCommand(text, [], { contextAttachmentCount: 1 })).toBeNull();
    },
  );

  it("does not consume commands with web element contexts", () => {
    expect(
      parseV4VisibleSlashCommand("/goal 修复登录", [], {
        contextAttachmentCount: 1,
      }),
    ).toBeNull();
  });

  it("keeps queued goal command syntax when edited to objective-only text", () => {
    expect(v4QueuedCommandText("sendGoalCommand", "新目标")).toBe("/goal 新目标");
    expect(v4QueuedCommandText("sendGoalCommand", "/target 新目标")).toBe("/target 新目标");
    expect(v4QueuedCommandText("sendText", "新目标")).toBe("新目标");
  });
});

describe("parseSelectionSideSlashCommand", () => {
  const enabledCommandNames = ["side", "btw"] as const;

  it("parses both aliases and preserves internal whitespace", () => {
    expect(
      parseSelectionSideSlashCommand("  /SIDE  你好\n继续查一下  ", [], {
        enabledCommandNames,
      }),
    ).toEqual({
      command: "side",
      text: "你好\n继续查一下",
      displayText: "/SIDE  你好\n继续查一下",
    });
    expect(parseSelectionSideSlashCommand("/btw 请继续", [], { enabledCommandNames })).toEqual({
      command: "btw",
      text: "请继续",
      displayText: "/btw 请继续",
    });
  });

  it("只消费带非空文字参数的完整输入", () => {
    expect(parseSelectionSideSlashCommand("/side", [], { enabledCommandNames })).toBeNull();
    expect(
      parseSelectionSideSlashCommand("先说 /side 你好", [], { enabledCommandNames }),
    ).toBeNull();
    expect(
      parseSelectionSideSlashCommand("/sidekick 你好", [], { enabledCommandNames }),
    ).toBeNull();
  });

  it("存在附件或结构化上下文时不消费 App 命令", () => {
    expect(
      parseSelectionSideSlashCommand("/side 你好", [{ ref: "zcode-artifact://a" }], {
        enabledCommandNames,
      }),
    ).toBeNull();
    expect(
      parseSelectionSideSlashCommand("/btw 你好", [], {
        contextAttachmentCount: 1,
        enabledCommandNames,
      }),
    ).toBeNull();
  });

  it("遵守 CLI 同名命令优先的有效 App 命令集合", () => {
    expect(
      parseSelectionSideSlashCommand("/side 你好", [], { enabledCommandNames: ["btw"] }),
    ).toBeNull();
    expect(
      parseSelectionSideSlashCommand("/btw 你好", [], { enabledCommandNames: ["btw"] }),
    ).toMatchObject({ command: "btw", text: "你好" });
  });
});
