import { describe, expect, it } from "vitest";
import {
  buildFileMentionMarkdown,
  buildMentionMarkdown,
  buildSkillMentionMarkdown,
  formatSkillMentionDisplayLabel,
  parseMentionMarkdown,
  renderMentionMarkdownAsPlainText,
} from "../src/mentions/mentionMarkdown.js";
import { collectSessionMentionItems } from "../src/mentions/providers/sessionsMentionProvider.js";
import {
  buildVisibleMentionGroups,
  filterMentionItems,
  filterMentionItemsWithOptions,
  getMentionGroupLimitForQuery,
  hasMentionQuery,
  MENTION_DEFAULT_GROUP_PREVIEW_LIMIT,
  MENTION_FILES_ONLY_DEFAULT_PREVIEW_LIMIT,
} from "../src/mentions/mentionSearch.js";
import type { MentionItem } from "../src/mentions/mentionTypes.js";

const items: MentionItem[] = [
  {
    id: "file:package.json",
    category: "files",
    label: "package.json",
    description: "package.json",
    value: "package.json",
    markdown: buildFileMentionMarkdown("package.json", "package.json"),
    keywords: ["/repo/package.json"],
  },
  {
    id: "file:packages/ui/src/LexicalChatInput.tsx",
    category: "files",
    label: "LexicalChatInput.tsx",
    description: "packages/ui/src/LexicalChatInput.tsx",
    value: "packages/ui/src/LexicalChatInput.tsx",
    markdown: buildFileMentionMarkdown(
      "packages/ui/src/LexicalChatInput.tsx",
      "LexicalChatInput.tsx",
    ),
    keywords: ["/repo/packages/ui/src/LexicalChatInput.tsx"],
  },
];

describe("buildFileMentionMarkdown", () => {
  it("serializes the file mention to markdown link syntax", () => {
    expect(
      buildFileMentionMarkdown("packages/ui/src/LexicalChatInput.tsx", "LexicalChatInput.tsx"),
    ).toBe("[LexicalChatInput.tsx](./packages/ui/src/LexicalChatInput.tsx)");
  });

  it("flattens serialized file mentions to plain text labels", () => {
    expect(
      renderMentionMarkdownAsPlainText(
        "请查看 [src/pages/\\[demo\\].html](./src/pages/\\[demo\\].html)",
      ),
    ).toBe("请查看 src/pages/[demo].html");
    expect(
      renderMentionMarkdownAsPlainText(
        "请查看旧格式 [@src/pages/\\[demo\\].html](<./src/pages/\\[demo\\].html>)",
      ),
    ).toBe("请查看旧格式 src/pages/[demo].html");
    expect(renderMentionMarkdownAsPlainText("**保持原样**")).toBe("**保持原样**");
  });
});

describe("buildSkillMentionMarkdown", () => {
  it("serializes skills mention to markdown link syntax when path exists", () => {
    expect(buildSkillMentionMarkdown("code-review", ".codex/skills/code-review/SKILL.md")).toBe(
      "[$code-review](./.codex/skills/code-review/SKILL.md)",
    );
  });

  it("falls back to inline syntax when path is missing", () => {
    expect(buildSkillMentionMarkdown("code-review")).toBe("$code-review");
  });

  it("buildMentionMarkdown supports skills category", () => {
    expect(
      buildMentionMarkdown({
        category: "skills",
        label: "Code Review",
        value: "code-review",
        data: {
          path: ".codex/skills/code-review/SKILL.md",
        },
      }),
    ).toBe("[$code-review](./.codex/skills/code-review/SKILL.md)");
  });

  it("buildMentionMarkdown supports sessions category", () => {
    expect(
      buildMentionMarkdown({
        category: "sessions",
        label: "Chat",
        value: "sess_123",
        data: {},
      }),
    ).toBe("[#Chat](#sess_123)");
  });
});

describe("parseMentionMarkdown", () => {
  it("parses skill links and keeps old inline skill syntax compatible", () => {
    expect(
      parseMentionMarkdown(
        "运行 [$agent-browser](./.agents/skills/agent-browser/SKILL.md) 然后 $code-review",
      ),
    ).toEqual([
      { type: "text", text: "运行 " },
      { type: "skill", label: "agent-browser" },
      { type: "text", text: " 然后 " },
      { type: "skill", label: "code-review" },
    ]);
  });

  it("parses inline session mentions", () => {
    expect(parseMentionMarkdown("发给 #archived 和 #sess_123 继续聊")).toEqual([
      { type: "text", text: "发给 #archived 和 " },
      { type: "session", label: "sess_123" },
      { type: "text", text: " 继续聊" },
    ]);
    expect(parseMentionMarkdown("发给 [#Review mailbox flow](#sess_123) 继续聊")).toEqual([
      { type: "text", text: "发给 " },
      { type: "session", label: "Review mailbox flow" },
      { type: "text", text: " 继续聊" },
    ]);
  });

  it("parses inline subagent mentions", () => {
    expect(parseMentionMarkdown("交给 @reviewer 继续")).toEqual([
      { type: "text", text: "交给 " },
      { type: "subagent", label: "reviewer" },
      { type: "text", text: " 继续" },
    ]);
  });

  it("parses directory links as directory mentions", () => {
    expect(
      parseMentionMarkdown("查看 [@src/components](<./src/components/>) 和 [src/app](./src/app/)"),
    ).toEqual([
      { type: "text", text: "查看 " },
      { type: "directory", label: "src/components" },
      { type: "text", text: " 和 " },
      { type: "directory", label: "src/app" },
    ]);
  });
  it("parses file links without keeping the legacy @ prefix", () => {
    expect(
      parseMentionMarkdown("查看 [@src/demo.ts](<./src/demo.ts>) 和 [src/app.ts](./src/app.ts)"),
    ).toEqual([
      { type: "text", text: "查看 " },
      { type: "file", label: "src/demo.ts" },
      { type: "text", text: " 和 " },
      { type: "file", label: "src/app.ts" },
    ]);
  });
});

describe("collectSessionMentionItems", () => {
  it("merges all known task sources and dedupes by ZCode Agent session id", () => {
    const workspacePath = "/local/workspace";
    const items = collectSessionMentionItems(
      [
        {
          taskId: "sess_local_old",
          traceId: "trace-local-old",
          title: "Local old",
          workspacePath,
          createdAt: 1,
          updatedAt: 10,
          mode: "default",
          provider: "glm",
        },
        {
          taskId: "sess_remote_new",
          traceId: "trace-remote-new",
          title: "Remote new",
          workspacePath: "/remote/workspace",
          workspaceIdentity: "ssh://box/remote/workspace",
          createdAt: 2,
          updatedAt: 100,
          mode: "default",
          provider: "glm",
        },
        {
          taskId: "sess_remote_new",
          traceId: "trace-remote-new-stale",
          title: "Remote stale duplicate",
          workspacePath: "/remote/workspace",
          workspaceIdentity: "ssh://box/remote/workspace",
          createdAt: 2,
          updatedAt: 90,
          mode: "default",
          provider: "glm",
        },
      ],
      "glm",
    );

    expect(items.map((item) => item.value)).toEqual(["sess_remote_new", "sess_local_old"]);
    expect(items[0]?.label).toBe("Remote new");
  });

  it("does not expose a leading session id from title text as the visible label", () => {
    const items = collectSessionMentionItems(
      [
        {
          taskId: "sess_visible_target",
          traceId: "trace-session-title",
          title: "#sess_visible_target continue this chat",
          workspacePath: "/workspace/current",
          createdAt: 1,
          updatedAt: 10,
          mode: "default",
          provider: "glm",
        },
      ],
      "glm",
    );

    expect(items[0]?.label).toBe("continue this chat");
    expect(items[0]?.markdown).toBe("[#continue this chat](#sess_visible_target)");
  });

  it("keeps app-created sessions, hides imported native history, and prioritizes the current workspace", () => {
    const items = collectSessionMentionItems(
      [
        {
          taskId: "sess_other_app",
          traceId: "trace-other-app",
          title: "Other app",
          workspacePath: "/workspace/other",
          createdAt: 1,
          updatedAt: 300,
          mode: "default",
          provider: "glm",
        },
        {
          taskId: "sess_current_app",
          traceId: "trace-current-app",
          title: "Current app",
          workspacePath: "/workspace/current",
          createdAt: 2,
          updatedAt: 100,
          mode: "default",
          provider: "glm",
        },
        {
          taskId: "sess_imported_native",
          traceId: "trace-imported-native",
          title: "Imported native",
          workspacePath: "/workspace/current",
          createdAt: 3,
          updatedAt: 400,
          mode: "default",
          provider: "claude",
          migrationSource: "claudeCode",
        },
      ],
      "glm",
      {
        workspacePath: "/workspace/current",
      },
    );

    expect(items.map((item) => item.value)).toEqual(["sess_current_app", "sess_other_app"]);
    expect(items.map((item) => item.description)).toEqual(["current", "other"]);
  });
});

describe("formatSkillMentionDisplayLabel", () => {
  it("将 kebab-case slug 格式化为标题样式展示", () => {
    expect(formatSkillMentionDisplayLabel("code-review")).toBe("Code Review");
  });

  it("已是带空格的短语时不改写", () => {
    expect(formatSkillMentionDisplayLabel("Code Review")).toBe("Code Review");
  });
});

describe("filterMentionItems", () => {
  it("keeps original order when query is empty", () => {
    expect(filterMentionItems(items, "").map((item) => item.id)).toEqual([
      "file:package.json",
      "file:packages/ui/src/LexicalChatInput.tsx",
    ]);
  });

  it("prioritizes files before directories in the default empty-query preview", () => {
    const mixedItems: MentionItem[] = [
      {
        id: "file:src",
        category: "files",
        label: "src",
        description: "src",
        value: "src",
        markdown: buildFileMentionMarkdown("src", "src", "directory"),
        data: { kind: "directory" },
      },
      {
        id: "file:package.json",
        category: "files",
        label: "package.json",
        description: "package.json",
        value: "package.json",
        markdown: buildFileMentionMarkdown("package.json", "package.json", "file"),
        data: { kind: "file" },
      },
      {
        id: "file:docs",
        category: "files",
        label: "docs",
        description: "docs",
        value: "docs",
        markdown: buildFileMentionMarkdown("docs", "docs", "directory"),
        data: { kind: "directory" },
      },
    ];

    expect(filterMentionItems(mixedItems, "").map((item) => item.id)).toEqual([
      "file:package.json",
      "file:src",
      "file:docs",
    ]);
  });

  it("matches by file name and relative path", () => {
    expect(filterMentionItems(items, "lexical").map((item) => item.id)).toEqual([
      "file:packages/ui/src/LexicalChatInput.tsx",
    ]);
    expect(filterMentionItems(items, "packages/ui").map((item) => item.id)).toEqual([
      "file:packages/ui/src/LexicalChatInput.tsx",
    ]);
  });

  it("can require a non-empty query before exposing any results", () => {
    expect(
      filterMentionItemsWithOptions(items, "", {
        requireQuery: true,
      }),
    ).toEqual([]);
  });

  it("can cap the number of returned results", () => {
    expect(
      filterMentionItemsWithOptions(items, "", {
        limit: 1,
      }).map((item) => item.id),
    ).toEqual(["file:package.json"]);
  });

  it("uses the small default group preview limit before the user types a query", () => {
    expect(MENTION_DEFAULT_GROUP_PREVIEW_LIMIT).toBe(3);
    expect(MENTION_FILES_ONLY_DEFAULT_PREVIEW_LIMIT).toBe(10);
    expect(getMentionGroupLimitForQuery("")).toBe(3);
    expect(getMentionGroupLimitForQuery("   ")).toBe(3);
    expect(getMentionGroupLimitForQuery("", MENTION_FILES_ONLY_DEFAULT_PREVIEW_LIMIT)).toBe(10);
    expect(getMentionGroupLimitForQuery("pkg")).toBeUndefined();
  });
});

// 插件 @ 引用中文搜索（feat/plugin_ref_i18n）：中文命中走本地化显示名 keywords 通道；
// CJK query 只保留前缀/子串两级，逐字符子序列仅对非 CJK query 生效。
describe("filterMentionItems CJK queries", () => {
  const pluginItems: MentionItem[] = [
    {
      id: "plugin:browser-use@zcode-plugins-official",
      category: "plugins",
      label: "浏览器操作",
      description: "zcode-plugins-official · 2 skills · 1 MCP",
      value: "browser-use@zcode-plugins-official",
      markdown: "[@browser-use](plugin://browser-use@zcode-plugins-official)",
      keywords: [
        "browser-use",
        "browser-use@zcode-plugins-official",
        "zcode-plugins-official",
        "浏览器操作",
      ],
    },
    {
      id: "plugin:zcode-cua@zcode-plugins-official",
      category: "plugins",
      label: "电脑控制",
      description: "zcode-plugins-official · 1 skills · 1 MCP",
      value: "zcode-cua@zcode-plugins-official",
      markdown: "[@zcode-cua](plugin://zcode-cua@zcode-plugins-official)",
      keywords: [
        "zcode-cua",
        "zcode-cua@zcode-plugins-official",
        "zcode-plugins-official",
        "电脑控制",
      ],
    },
  ];

  it("matches Chinese display names by prefix and substring", () => {
    expect(filterMentionItems(pluginItems, "浏览").map((item) => item.id)).toEqual([
      "plugin:browser-use@zcode-plugins-official",
    ]);
    expect(filterMentionItems(pluginItems, "览器").map((item) => item.id)).toEqual([
      "plugin:browser-use@zcode-plugins-official",
    ]);
    expect(filterMentionItems(pluginItems, "控制").map((item) => item.id)).toEqual([
      "plugin:zcode-cua@zcode-plugins-official",
    ]);
  });

  it("does not fall back to per-character subsequence matching for CJK queries", () => {
    // 「浏器」是「浏览器操作」的非连续子序列；CJK query 不应命中。
    expect(filterMentionItems(pluginItems, "浏器")).toEqual([]);
  });

  it("keeps subsequence matching for ASCII queries", () => {
    expect(filterMentionItems(pluginItems, "bru").map((item) => item.id)).toEqual([
      "plugin:browser-use@zcode-plugins-official",
    ]);
  });
});

describe("hasMentionQuery", () => {
  it("only enables search when the query contains non-whitespace characters", () => {
    expect(hasMentionQuery("")).toBe(false);
    expect(hasMentionQuery("   ")).toBe(false);
    expect(hasMentionQuery("pkg")).toBe(true);
  });
});

describe("buildVisibleMentionGroups", () => {
  it("only keeps groups that have results, loading state, or errors", () => {
    expect(
      buildVisibleMentionGroups([
        {
          id: "empty",
          title: "Empty",
          items: [],
          loading: false,
          errorText: null,
          emptyText: "no items",
        },
        {
          id: "files",
          title: "Files",
          items,
          loading: false,
          errorText: null,
          emptyText: "no files",
        },
      ]).map((group) => group.id),
    ).toEqual(["files"]);
  });
});

describe("filterMentionItemsWithOptions – no hard cap", () => {
  const manyItems: MentionItem[] = Array.from({ length: 500 }, (_, i) => ({
    id: `file:src/file${i}.ts`,
    category: "files" as const,
    label: `file${i}.ts`,
    description: `src/file${i}.ts`,
    value: `src/file${i}.ts`,
    markdown: `[src/file${i}.ts](src/file${i}.ts)`,
    keywords: [],
  }));

  it("returns all matching items when no explicit limit is set", () => {
    const result = filterMentionItemsWithOptions(manyItems, "file");
    expect(result.length).toBe(500);
  });

  it("respects an explicit limit when provided", () => {
    const result = filterMentionItemsWithOptions(manyItems, "file", { limit: 10 });
    expect(result.length).toBe(10);
  });
});
