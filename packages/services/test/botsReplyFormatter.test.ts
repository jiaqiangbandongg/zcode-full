import { describe, expect, it } from "vitest";
import {
  extractBotAssistantResponseMessages,
  formatBotAssistantReplyBlocks,
  formatBotPermissionRequestSummary,
  formatBotToolCallReply,
  isBotToolCallReplyTerminal,
  updateBotReplyToolCalls,
  type BotReplyToolCallState,
} from "../src/bots/replyFormatter.js";
import type { ZCodeStreamEvent, ZCodeTaskChangeSummary } from "@zcode/shared";

const changeSummary: ZCodeTaskChangeSummary = {
  fileCount: 2,
  added: 12,
  removed: 4,
  files: [
    {
      path: "packages/ui/src/App.tsx",
      added: 10,
      removed: 2,
      writeCount: 1,
      lastTurnIndex: 1,
    },
    {
      path: "packages/services/src/bots/botsService.ts",
      added: 2,
      removed: 2,
      writeCount: 1,
      lastTurnIndex: 1,
    },
  ],
};

describe("bot reply formatter", () => {
  it("formats assistant response blocks with change summary", () => {
    const messages = formatBotAssistantReplyBlocks([
      { type: "content", content: "已经完成。" },
      { type: "change-summary", changeSummary },
    ]);

    expect(messages).toContain("已经完成。");
    expect(messages).toContain("变更摘要：2 个文件，🟢 `+12` 🔴 `-4`\n- `packages/ui/src/App.tsx` (🟢 `+10` 🔴 `-2`)\n- `packages/services/src/bots/botsService.ts` (🟢 `+2` 🔴 `-2`)");
    expect(messages.join("\n")).not.toContain("工具调用：");
  });

  it("formats assistant response blocks with tool block and change summary", () => {
    const toolCall: BotReplyToolCallState =
      {
        toolId: "tool-1",
        title: "Edit file",
        kind: "edit",
        input: { file_path: "/repo/project/packages/ui/src/App.tsx" },
        status: "completed",
      };

    const messages = formatBotAssistantReplyBlocks(
      [
        { type: "content", content: "已经完成。" },
        { type: "tool-call", toolCall },
        { type: "change-summary", changeSummary },
      ],
      { workspacePath: "/repo/project" },
    );

    expect(messages).toContain("已经完成。");
    expect(messages).toContain("工具调用：\n- 完成 · Edit file · `packages/ui/src/App.tsx`");
    expect(messages.join("\n")).toContain("变更摘要：2 个文件，🟢 `+12` 🔴 `-4`");
  });

  it("keeps selected assistant response paragraphs in one message", () => {
    const messages = formatBotAssistantReplyBlocks([
      { type: "content", content: "第一句。第二句！\n\n第三段" },
      { type: "change-summary", changeSummary },
    ]);

    expect(messages[0]).toBe("第一句。第二句！\n\n第三段");
    expect(messages.at(-1)).toContain("变更摘要：2 个文件，🟢 `+12` 🔴 `-4`");
  });

  it("buffers streaming assistant responses until terminal flush", () => {
    expect(
      extractBotAssistantResponseMessages("这是第一句。第二句还没换行", false),
    ).toEqual({
      messages: [],
      rest: "这是第一句。第二句还没换行",
    });

    expect(
      extractBotAssistantResponseMessages("第一段。\n\n第二段还在流式输出", false),
    ).toEqual({
      messages: [],
      rest: "第一段。\n\n第二段还在流式输出",
    });

    expect(
      extractBotAssistantResponseMessages("第一段。\n\n第二段", true),
    ).toEqual({
      messages: ["第一段。\n\n第二段"],
      rest: "",
    });
  });

  it("splits the whole selected latest part instead of taking only its last paragraph", () => {
    const messages = formatBotAssistantReplyBlocks([
      {
        type: "content",
        content:
          "已把 index.html 改成单文件贪吃蛇，直接打开就能玩。包含键盘方向键 / WASD 控制、空格暂停、开始/重开按钮、分数与最高分记录，以及手机端方向按钮。\n\n" +
          "我顺手修了一个常见判定问题：蛇在不吃食物时允许走到“尾巴刚离开的位置”，不会被误判成撞到自己，逻辑在 index.html。这次没法实际开浏览器联调，只做了静态检查；如果你要，我可以继续帮你加“加速模式”或“穿墙模式”。",
      },
    ]);

    expect(messages).toEqual([
      "已把 index.html 改成单文件贪吃蛇，直接打开就能玩。包含键盘方向键 / WASD 控制、空格暂停、开始/重开按钮、分数与最高分记录，以及手机端方向按钮。\n\n" +
        "我顺手修了一个常见判定问题：蛇在不吃食物时允许走到“尾巴刚离开的位置”，不会被误判成撞到自己，逻辑在 index.html。这次没法实际开浏览器联调，只做了静态检查；如果你要，我可以继续帮你加“加速模式”或“穿墙模式”。",
    ]);
  });

  it("collects tool call updates from stream events", () => {
    const toolCalls = new Map<string, BotReplyToolCallState>();
    updateBotReplyToolCalls(toolCalls, {
      type: "tool_call",
      taskId: "task-1",
      traceId: "trace-1",
      toolId: "tool-1",
      title: "Run command",
      kind: "execute",
      input: { command: "pnpm test" },
      raw: {},
    } as ZCodeStreamEvent);
    updateBotReplyToolCalls(toolCalls, {
      type: "tool_call_update",
      taskId: "task-1",
      traceId: "trace-1",
      toolId: "tool-1",
      status: "completed",
      content: "ok",
      raw: {},
    } as ZCodeStreamEvent);

    expect([...toolCalls.values()]).toMatchObject([
      {
        toolId: "tool-1",
        title: "Run command",
        kind: "execute",
        input: { command: "pnpm test" },
        output: "ok",
        status: "completed",
      },
    ]);
  });

  it("formats individual terminal tool call replies", () => {
    expect(isBotToolCallReplyTerminal("completed")).toBe(true);
    expect(isBotToolCallReplyTerminal("in_progress")).toBe(false);
    expect(
      formatBotToolCallReply({
        toolId: "tool-1",
        title: "Run command",
        input: { command: "pnpm test" },
        status: "completed",
      }),
    ).toBe("工具调用：\n- 完成 · Run command · `pnpm test`");
  });

  it("shortens long run commands in tool call replies", () => {
    const longCommand =
      "pnpm vitest run packages/services/test/botsReplyFormatter.test.ts packages/services/test/botsService.test.ts --reporter verbose --runInBand";

    const text = formatBotToolCallReply({
      toolId: "tool-1",
      title: "Run command",
      input: { command: longCommand },
      status: "completed",
    });

    expect(text).toBe(
      "工具调用：\n- 完成 · Run command · `pnpm vitest run packages/services/test/botsReplyFormatter.te ...  --reporter verbose --runInBand`",
    );
    expect(text).not.toContain("botsService.test.ts");
  });

  it("shortens long run commands in permission request summaries", () => {
    const longCommand =
      "npm exec very-long-script -- --workspace /Users/me/project --target packages/services/src/bots/replyFormatter.ts --include-generated false";

    const text = formatBotPermissionRequestSummary({
      title: "Permission Required",
      kind: "execute",
      raw: { rawInput: { command: longCommand } },
    });

    expect(text).toBe(
      "需要权限：\nPermission Required\n`npm exec very-long-script -- --workspace /Users/me/project - ... er.ts --include-generated false`",
    );
    expect(text).not.toContain("packages/services/src/bots");
  });

  it("uses edit kind labels in permission request titles", () => {
    const text = formatBotPermissionRequestSummary(
      {
        title: "Edit /Users/dev/ZCodeProject/Gomoku/index.html",
        kind: "edit",
        raw: { rawInput: { file_path: "/Users/dev/ZCodeProject/Gomoku/index.html" } },
      },
      { locale: "en-US" },
    );

    expect(text).toBe(
      "Permission required:\nEditing /Users/dev/ZCodeProject/Gomoku/index.html\n`/Users/dev/ZCodeProject/Gomoku/index.html`",
    );
  });

  it("specializes edit permission kind labels from file changes", () => {
    const text = formatBotPermissionRequestSummary(
      {
        title: "Edit /Users/dev/ZCodeProject/Gomoku/index.html",
        kind: "edit",
        raw: {
          changes: {
            "/Users/dev/ZCodeProject/Gomoku/index.html": {
              type: "add",
              content: "<html></html>",
            },
          },
        },
      },
      { locale: "en-US" },
    );

    expect(text).toBe(
      "Permission required:\nWriting /Users/dev/ZCodeProject/Gomoku/index.html\n`/Users/dev/ZCodeProject/Gomoku/index.html`",
    );
  });

  it("uses editing for update file change permission labels", () => {
    const text = formatBotPermissionRequestSummary(
      {
        title: "Edit /Users/dev/ZCodeProject/Gomoku/index.html",
        kind: "edit",
        raw: {
          changes: {
            "/Users/dev/ZCodeProject/Gomoku/index.html": {
              type: "update",
              content: "<html></html>",
            },
          },
        },
      },
      { locale: "en-US" },
    );

    expect(text).toBe(
      "Permission required:\nEditing /Users/dev/ZCodeProject/Gomoku/index.html\n`/Users/dev/ZCodeProject/Gomoku/index.html`",
    );
  });

  it("formats edit tool file paths relative to the workspace", () => {
    expect(
      formatBotToolCallReply(
        {
          toolId: "tool-1",
          title: "Edit file",
          kind: "edit",
          input: { file_path: "/Users/me/project/src/demo.md" },
          status: "completed",
        },
        { workspacePath: "/Users/me/project" },
      ),
    ).toBe("工具调用：\n- 完成 · Edit file · `src/demo.md`");
  });

  it("escapes inline code markers in change summary paths", () => {
    const messages = formatBotAssistantReplyBlocks([
      {
        type: "change-summary",
        changeSummary: {
          fileCount: 1,
          added: 1,
          removed: 0,
          files: [
            {
              path: "src/weird`file.ts",
              added: 1,
              removed: 0,
              writeCount: 1,
              lastTurnIndex: 1,
            },
          ],
        },
      },
    ]);

    expect(messages.join("\n")).toContain("- `src/weird\\`file.ts` (🟢 `+1`)");
  });
});
