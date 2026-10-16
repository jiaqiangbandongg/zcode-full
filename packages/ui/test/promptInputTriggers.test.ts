import { describe, expect, it } from "vitest";
import {
  extractActivePromptInputTrigger,
  filterPromptInputSuggestions,
  getBestPromptInputSuggestionIndex,
  replaceActivePromptInputToken,
  type PromptInputSuggestionItem,
} from "../src/lib/promptInputTriggers.js";

const suggestions: PromptInputSuggestionItem[] = [
  {
    id: "slash:plan",
    trigger: "/",
    value: "plan",
    label: "创建执行计划",
    description: "先拆解任务再开始。",
    keywords: ["planning", "步骤"],
  },
  {
    id: "slash:review",
    trigger: "/",
    value: "review",
    label: "代码审查",
    description: "检查 bug 和测试缺口。",
    keywords: ["code review", "bug"],
  },
  {
    id: "mention:workspace",
    trigger: "@",
    value: "workspace",
    label: "当前工作区",
    description: "整个仓库上下文。",
    keywords: ["repo", "project"],
  },
  {
    id: "skill:code-review",
    trigger: "$",
    value: "code-review",
    label: "代码审查技能",
    description: "执行代码审查流程。",
    keywords: ["skills", "review"],
  },
  {
    id: "session:recent",
    trigger: "#",
    value: "recent",
    label: "最近会话",
    description: "继续最近会话。",
    keywords: ["session"],
  },
];

describe("extractActivePromptInputTrigger", () => {
  it("识别开头的 slash 和空 query", () => {
    expect(extractActivePromptInputTrigger("/plan")).toEqual({
      trigger: "/",
      query: "plan",
    });
    expect(extractActivePromptInputTrigger("/")).toEqual({
      trigger: "/",
      query: "",
    });
  });

  it("识别空白后的 mention", () => {
    expect(extractActivePromptInputTrigger("请参考 @work")).toEqual({
      trigger: "@",
      query: "work",
    });
    expect(extractActivePromptInputTrigger("第一行\n@repo")).toEqual({
      trigger: "@",
      query: "repo",
    });
    expect(extractActivePromptInputTrigger("请执行 $code")).toEqual({
      trigger: "$",
      query: "code",
    });
    expect(extractActivePromptInputTrigger("请执行 ¥code")).toEqual({
      trigger: "$",
      query: "code",
    });
    expect(extractActivePromptInputTrigger("请执行 ￥code")).toEqual({
      trigger: "$",
      query: "code",
    });
    expect(extractActivePromptInputTrigger("发给 #sess_123")).toEqual({
      trigger: "#",
      query: "sess_123",
    });
  });

  it("识别中文文本或中文标点后的 mention", () => {
    expect(extractActivePromptInputTrigger("请帮我看看@浏览器")).toEqual({
      trigger: "@",
      query: "浏览器",
    });
    expect(extractActivePromptInputTrigger("请帮我看看，@浏览器")).toEqual({
      trigger: "@",
      query: "浏览器",
    });
    expect(extractActivePromptInputTrigger("请帮我看看@浏览器")).not.toBeNull();
  });

  it("不会把中文前缀的邮箱当成 mention，空格后带点号的 @ 仍触发", () => {
    expect(extractActivePromptInputTrigger("联系邮箱@example.com")).toBeNull();
    expect(extractActivePromptInputTrigger("用户@例子.公司")).toBeNull();
    expect(extractActivePromptInputTrigger("看看 @foo.bar")).toEqual({
      trigger: "@",
      query: "foo.bar",
    });
    expect(extractActivePromptInputTrigger("看看，@browser.use")).toEqual({
      trigger: "@",
      query: "browser.use",
    });
    expect(extractActivePromptInputTrigger("看看@浏览器。")).toEqual({
      trigger: "@",
      query: "浏览器。",
    });
  });

  it("不会把普通邮箱和带空格的 token 当成触发词", () => {
    expect(extractActivePromptInputTrigger("hello@repo.com")).toBeNull();
    expect(extractActivePromptInputTrigger("hello@repo")).toBeNull();
    expect(extractActivePromptInputTrigger("请帮我看看/浏览器")).toBeNull();
    expect(extractActivePromptInputTrigger("/plan test")).toBeNull();
    expect(extractActivePromptInputTrigger("")).toBeNull();
  });
});

describe("filterPromptInputSuggestions", () => {
  it("空 query 时保持原始顺序", () => {
    expect(filterPromptInputSuggestions(suggestions, "").map((item) => item.id)).toEqual([
      "slash:plan",
      "slash:review",
      "mention:workspace",
      "skill:code-review",
      "session:recent",
    ]);
  });

  it("优先前缀匹配，再退化到描述和关键词的模糊匹配", () => {
    expect(filterPromptInputSuggestions(suggestions, "pla").map((item) => item.id)).toEqual([
      "slash:plan",
    ]);
    expect(filterPromptInputSuggestions(suggestions, "repo").map((item) => item.id)).toEqual([
      "mention:workspace",
    ]);
    expect(filterPromptInputSuggestions(suggestions, "cr").map((item) => item.id)).toEqual([
      "skill:code-review",
      "slash:review",
    ]);
  });
});

describe("getBestPromptInputSuggestionIndex", () => {
  it("展示顺序保留分组时，选中项仍优先全局最佳匹配", () => {
    const groupedSuggestions: PromptInputSuggestionItem[] = [
      {
        id: "slash:agent-browser",
        trigger: "/",
        value: "agent-browser",
        label: "/agent-browser",
        description: "Browser automation CLI for AI agents",
        keywords: ["agent-browser", "Browser automation CLI for AI agents"],
      },
      {
        id: "skill:brainstorming",
        trigger: "/",
        value: "brainstorming",
        label: "brainstorming",
        description: "Explore requirements before implementation",
        keywords: ["brainstorming", "Explore requirements before implementation"],
      },
    ];

    expect(getBestPromptInputSuggestionIndex(groupedSuggestions, "bra")).toBe(1);
  });
});

describe("replaceActivePromptInputToken", () => {
  it("替换 slash token 并把光标放到结果后面", () => {
    expect(
      replaceActivePromptInputToken("/pl", "an", {
        trigger: "/",
        value: "plan",
      }),
    ).toEqual({
      cursorOffset: 6,
      text: "/plan ",
    });
  });

  it("完整 slash token 后紧贴正文时不吞掉正文", () => {
    expect(
      replaceActivePromptInputToken("/goal", "修复这个问题", {
        trigger: "/",
        value: "goal",
      }),
    ).toEqual({
      cursorOffset: 6,
      text: "/goal 修复这个问题",
    });

    expect(
      replaceActivePromptInputToken("/goal", "fix this", {
        trigger: "/",
        value: "goal",
      }),
    ).toEqual({
      cursorOffset: 6,
      text: "/goal fix this",
    });
  });

  it("只吞掉和候选值匹配的未输入后缀", () => {
    expect(
      replaceActivePromptInputToken("/go", "al修复这个问题", {
        trigger: "/",
        value: "goal",
      }),
    ).toEqual({
      cursorOffset: 6,
      text: "/goal 修复这个问题",
    });

    expect(
      replaceActivePromptInputToken("/go", "修复这个问题", {
        trigger: "/",
        value: "goal",
      }),
    ).toEqual({
      cursorOffset: 6,
      text: "/goal 修复这个问题",
    });
  });

  it("替换 mention token 时保留后续空白后的正文", () => {
    expect(
      replaceActivePromptInputToken("请看 @wor", "k 这里", {
        trigger: "@",
        value: "workspace",
      }),
    ).toEqual({
      cursorOffset: 14,
      text: "请看 @workspace  这里",
    });
  });

  it("替换 skill token 时保留后续空白后的正文", () => {
    expect(
      replaceActivePromptInputToken("请执行 $cod", "e-review 这里", {
        trigger: "$",
        value: "code-review",
      }),
    ).toEqual({
      cursorOffset: 17,
      text: "请执行 $code-review  这里",
    });
  });

  it("把 yen 符号当作 skill trigger 别名替换为 skill mention", () => {
    expect(
      replaceActivePromptInputToken("请执行 ¥cod", "e-review 这里", {
        trigger: "$",
        value: "code-review",
      }),
    ).toEqual({
      cursorOffset: 17,
      text: "请执行 $code-review  这里",
    });

    expect(
      replaceActivePromptInputToken("请执行 ￥cod", "e-review 这里", {
        trigger: "$",
        value: "code-review",
      }),
    ).toEqual({
      cursorOffset: 17,
      text: "请执行 $code-review  这里",
    });
  });

  it("裸触发符插入在已有正文前时，不清理光标后的正文", () => {
    expect(
      replaceActivePromptInputToken("请看 @", "后面的文字", {
        trigger: "@",
        value: "workspace",
      }),
    ).toEqual({
      cursorOffset: 14,
      text: "请看 @workspace 后面的文字",
    });

    expect(
      replaceActivePromptInputToken("继续 #", "已有会话", {
        trigger: "#",
        value: "recent",
      }),
    ).toEqual({
      cursorOffset: 11,
      text: "继续 #recent 已有会话",
    });

    expect(
      replaceActivePromptInputToken("执行 $", "后面的文字", {
        trigger: "$",
        value: "code-review",
      }),
    ).toEqual({
      cursorOffset: 16,
      text: "执行 $code-review 后面的文字",
    });

    expect(
      replaceActivePromptInputToken("运行 /", "后面的文字", {
        trigger: "/",
        value: "plan",
      }),
    ).toEqual({
      cursorOffset: 9,
      text: "运行 /plan 后面的文字",
    });
  });

  it("trigger 被删除后返回 null", () => {
    expect(
      replaceActivePromptInputToken("请看 work", "", {
        trigger: "@",
        value: "workspace",
      }),
    ).toBeNull();
  });
});
