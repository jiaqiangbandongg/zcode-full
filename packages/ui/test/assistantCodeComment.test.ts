import { describe, expect, it } from "vitest";
import {
  buildAssistantCodeCommentCards,
  extractAssistantCodeComments,
  projectAssistantCodeComments,
} from "@/lib/assistantCodeComment.js";

describe("assistant code-comment parser", () => {
  it("解析必填字段、范围、优先级、Unicode 和跨平台路径", () => {
    const content = [
      '::code-comment{title="[P1] 空指针风险" body="user 为空时仍访问 user.id" file="src/用户 服务.ts" start=42 end=45 priority=1 ignored="yes"}',
      String.raw`::code-comment{title='Windows path' body='保留反斜杠' file='C:\repo\src\main.ts' start=9}`,
    ].join("\n");

    expect(extractAssistantCodeComments(content)).toMatchObject([
      {
        title: "[P1] 空指针风险",
        body: "user 为空时仍访问 user.id",
        file: "src/用户 服务.ts",
        startLine: 42,
        endLine: 45,
        priority: 1,
      },
      {
        title: "Windows path",
        body: "保留反斜杠",
        file: String.raw`C:\repo\src\main.ts`,
        startLine: 9,
        endLine: 9,
      },
    ]);
  });

  it("默认不为 code-comment 放宽智能引号语法", () => {
    expect(
      extractAssistantCodeComments("::code-comment{title=“标题” body=“正文” file=“src/main.ts”}"),
    ).toMatchObject([
      {
        title: "“标题”",
        body: "“正文”",
        file: "“src/main.ts”",
      },
    ]);
  });

  it("允许 body 中包含 Markdown 反引号和 directive 样例文本，不产生嵌套伪卡片", () => {
    const content =
      '::code-comment{title="Guard" body="Check `user.id`; do not emit ::code-comment{title=\\"fake\\"}" file="src/user.ts"}';

    expect(extractAssistantCodeComments(content)).toMatchObject([
      {
        title: "Guard",
        body: 'Check `user.id`; do not emit ::code-comment{title="fake"}',
        file: "src/user.ts",
      },
    ]);
  });

  it("忽略 fenced/inline code 中的示例，并保留语法错误或缺少必填字段的原文", () => {
    const valid = '::code-comment{title="Real" body="Actionable" file="src/real.ts" priority=2}';
    const invalid = '::code-comment{title="Missing body" file="src/no.ts"}';
    const content = [
      "```text",
      '::code-comment{title="Example" body="Only docs" file="src/example.ts"}',
      "```",
      '`::code-comment{title="Inline" body="Only docs" file="src/inline.ts"}`',
      invalid,
      valid,
    ].join("\n");

    const projection = projectAssistantCodeComments(content, { streaming: false });

    expect(projection.comments).toHaveLength(1);
    expect(projection.comments[0]?.title).toBe("Real");
    expect(projection.visibleText).toContain("Example");
    expect(projection.visibleText).toContain("Inline");
    expect(projection.visibleText).toContain(invalid);
    expect(projection.visibleText).not.toContain(valid);
  });

  it("独占行删除整行、内联指令替换为空格，streaming 未闭合尾部不闪现", () => {
    const standalone = '::code-comment{title="One" body="Standalone" file="src/a.ts"}';
    const inline = '::code-comment{title="Two" body="Inline" file="src/b.ts" start=3}';
    const complete = projectAssistantCodeComments(`before\n${standalone}\nafter ${inline} text`, {
      streaming: false,
    });

    expect(complete.visibleText).toBe("before\nafter   text");
    expect(complete.comments).toHaveLength(2);

    expect(
      projectAssistantCodeComments('正文\n::code-comment{title="partial" body="still streaming', {
        streaming: true,
      }).visibleText,
    ).toBe("正文\n");
    expect(
      projectAssistantCodeComments('正文\n::code-comment{title="partial" body="terminal', {
        streaming: false,
      }).visibleText,
    ).toContain("::code-comment");
  });

  it("流式协议名称尚未到左大括号前也不泄露", () => {
    const prefixes = [
      "::",
      "::code",
      "::code-comment",
      '::code-comment{title="partial" body="still streaming',
      ":::zcode-file-cit",
    ];

    for (const prefix of prefixes) {
      expect(projectAssistantCodeComments(`正文\n${prefix}`, { streaming: true }).visibleText).toBe(
        "正文\n",
      );
    }
  });

  it("协议前缀分叉或位于代码块时不误吞正文", () => {
    expect(
      projectAssistantCodeComments("正文\n::code-review", { streaming: true }).visibleText,
    ).toContain("::code-review");
    expect(
      projectAssistantCodeComments("```text\n::code-comment\n```", { streaming: true }).visibleText,
    ).toContain("::code-comment");
    expect(
      projectAssistantCodeComments(
        ':code-comment{title="Legacy" body="must stay strict" file="src/a.ts"}',
        { streaming: false },
      ).comments,
    ).toEqual([]);
  });

  it("构建 workspace 内卡片并拒绝相对越界和 workspace 外绝对路径", () => {
    const cards = buildAssistantCodeCommentCards(
      [
        '::code-comment{title="中文" body="正文" file="src/中文 路径.ts" start=2 end=4 priority=0}',
        '::code-comment{title="escape" body="bad" file="foo/../../private.ts"}',
        '::code-comment{title="outside" body="bad" file="/private/outside.ts"}',
      ].join("\n"),
      "/workspace",
    );

    expect(cards).toMatchObject([
      {
        title: "中文",
        body: "正文",
        path: "/workspace/src/中文 路径.ts",
        displayPath: "src/中文 路径.ts",
        startLine: 2,
        endLine: 4,
        priority: 0,
      },
    ]);
  });

  it("Windows 盘符和 UNC workspace 内路径使用大小写不敏感包含判断", () => {
    expect(
      buildAssistantCodeCommentCards(
        String.raw`::code-comment{title="Win" body="ok" file="c:\Repo\SRC\main.ts"}`,
        String.raw`C:\repo`,
      )[0]?.displayPath,
    ).toBe("SRC/main.ts");
    expect(
      buildAssistantCodeCommentCards(
        String.raw`::code-comment{title="UNC" body="ok" file="\\\\server\share\repo\src\main.ts"}`,
        String.raw`\\server\share\repo`,
      )[0]?.displayPath,
    ).toBe("src/main.ts");
  });

  it("Home-relative code comment 在 Home 位于 workspace 时复用统一解析器", () => {
    const cards = buildAssistantCodeCommentCards(
      '::code-comment{title="Home" body="ok" file="~/src/main.ts"}',
      "/workspace",
      50,
      { homePath: "/workspace" },
    );

    expect(cards).toMatchObject([
      {
        path: "/workspace/src/main.ts",
        displayPath: "src/main.ts",
      },
    ]);
  });

  it("根目录 workspace 仍能生成绝对文件的相对展示路径", () => {
    const cards = buildAssistantCodeCommentCards(
      '::code-comment{title="Root file" body="检查根目录文件" file="/src/main.ts"}',
      "/",
    );

    expect(cards).toMatchObject([
      {
        path: "/src/main.ts",
        displayPath: "src/main.ts",
      },
    ]);
  });

  it("单轮最多生成 50 张卡片且保持 directive 正序", () => {
    const content = Array.from(
      { length: 55 },
      (_, index) =>
        `::code-comment{title="Comment ${index + 1}" body="Body" file="src/file-${index + 1}.ts"}`,
    ).join("\n");
    const cards = buildAssistantCodeCommentCards(content, "/workspace");

    expect(cards).toHaveLength(50);
    expect(cards[0]?.title).toBe("Comment 1");
    expect(cards.at(-1)?.title).toBe("Comment 50");
  });
});
