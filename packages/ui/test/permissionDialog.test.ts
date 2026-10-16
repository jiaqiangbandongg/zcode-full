import {
  OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME,
  type ZCodePermissionRequest,
  type ZCodeProvider,
} from "@zcode/shared";
import { createElement } from "react";
import type { ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PermissionDialog } from "../src/PermissionDialog.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";

const WORKSPACE_PATH = "/Users/dev/ZCodeProject/demo";
const SUBAGENT_ORIGIN = {
  kind: "subagent" as const,
  agentId: "general-purpose",
  agentType: "general-purpose",
  childSessionId: "sess-child",
  parentSessionId: "sess-parent",
  parentToolCallId: "tool-parent-agent",
};

function renderPermissionDialog(
  request: ZCodePermissionRequest,
  provider?: ZCodeProvider,
  extraProps: Record<string, unknown> = {},
) {
  const Dialog = PermissionDialog as ComponentType<Record<string, unknown>>;
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(Dialog, {
        request,
        onRespond: () => {},
        workspacePath: WORKSPACE_PATH,
        provider,
        ...extraProps,
      }),
    ),
  );
}

describe("PermissionDialog", () => {
  it("renders the optional feedback input only when V4 enables it", () => {
    const withoutFeedback = renderPermissionDialog({
      type: "permission_request",
      taskId: "task-no-feedback",
      traceId: "trace-no-feedback",
      requestId: "request-no-feedback",
      description: "Run ls",
      kind: "Bash",
      options: [
        {
          optionId: "deny",
          kind: "deny",
          name: "Deny",
          response: { decision: "deny" },
        },
      ],
      raw: { command: "ls" },
    });
    const withFeedback = renderPermissionDialog({
      type: "permission_request",
      taskId: "task-feedback",
      traceId: "trace-feedback",
      requestId: "request-feedback",
      description: "Run ls",
      kind: "Bash",
      freeText: true,
      options: [
        {
          optionId: "deny",
          kind: "deny",
          name: "Deny",
          response: { decision: "deny" },
        },
      ],
      raw: { command: "ls" },
    });

    expect(withoutFeedback).not.toContain("chat.permission.feedback.placeholder");
    expect(withFeedback).toContain("告诉模型接下来应该怎么做...");
    expect(withFeedback).toContain("<textarea");
    expect(withFeedback).toContain('wrap="soft"');
    expect(withFeedback).toContain("field-sizing-content");
    expect(withFeedback).toContain("max-h-[5lh]");
    expect(withFeedback).toContain("overflow-y-auto");
    expect(withFeedback).toContain("focus-visible:ring-0");
    expect(withFeedback).toContain('maxLength="4096"');
  });

  it("labels an authority-verified Computer Use project grant explicitly", () => {
    const html = renderPermissionDialog({
      type: "permission_request",
      taskId: "task-cua",
      traceId: "trace-cua",
      requestId: "request-cua",
      description: "Control TextEdit",
      kind: "mcp__computer-use__left_click",
      title: "Computer Use",
      options: [
        {
          optionId: "allow_project",
          kind: "allow_always",
          name: "Always allow Computer Use in this project",
          response: {
            decision: "allow",
            permissionUpdates: [
              {
                behavior: "allow",
                rules: [{ toolName: OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME }],
                type: "addRules",
              },
            ],
          },
        },
      ],
      raw: { rawInput: { app_ref: { bundle_id: "com.apple.TextEdit" } } },
    });

    expect(html).toContain("始终允许本项目中的电脑控制");
    expect(html).toContain('aria-label="始终允许本项目中的电脑控制"');
    expect(html).toContain('aria-label="确认"');
    expect(html).toContain("本项目后续官方电脑控制操作不再询问");
    expect(html).not.toContain("后续相同权限请求不再询问");
  });

  it("renders compound prefix scopes inline without an exact-command card", () => {
    const html = renderPermissionDialog({
      type: "permission_request",
      taskId: "task-1",
      traceId: "trace-1",
      requestId: "request-scopes",
      description: "Run commands",
      kind: "Bash",
      title: "Bash",
      options: [
        {
          optionId: "allow_project",
          kind: "allow_always",
          name: "Always allow in this project",
          response: {
            decision: "allow",
            permissionUpdates: [
              {
                behavior: "allow",
                rules: [
                  { ruleContent: "pnpm run lint:*", toolName: "Bash" },
                  { ruleContent: "rm -rf ./generated", toolName: "Bash" },
                ],
                type: "addRules",
              },
            ],
          },
        },
      ],
      raw: {
        rawInput: { command: "pnpm run lint --fix && rm -rf ./generated" },
      },
    });

    expect(html).toContain('data-permission-rule-scopes="true"');
    expect(html).toContain('data-permission-rule-prefixes="true"');
    expect(html).toContain('data-permission-option-kind="allowAlways"');
    expect(html).toContain('data-permission-rule-scope="prefix"');
    expect(html).not.toContain('data-permission-rule-scope="exact"');
    expect(html).not.toContain("命令前缀");
    expect(html).not.toContain("后续相同命令不再询问");
    expect(html).toContain("pnpm run lint …");
    expect(html).not.toContain("仅此命令");
    expect(html).toContain("rm -rf ./generated");
    expect(html).not.toContain("<input");
  });

  it("does not render exact permission rules inside the allow-always option", () => {
    const heredocBody = `HEREDOC_BODY_MUST_NOT_RENDER_${"x".repeat(1000)}`;
    const oversizedTail = `${"y".repeat(300)}OVERSIZED_TAIL_MUST_NOT_RENDER`;
    const html = renderPermissionDialog({
      type: "permission_request",
      taskId: "task-1",
      traceId: "trace-1",
      requestId: "request-long-exact",
      description: "Write generated files",
      kind: "Bash",
      title: "Bash",
      options: [
        {
          optionId: "allow_project",
          kind: "allow_always",
          name: "Always allow in this project",
          response: {
            decision: "allow",
            permissionUpdates: [
              {
                behavior: "allow",
                rules: [
                  {
                    ruleContent: `cat > /tmp/sun.html << 'EOF'\n${heredocBody}\nEOF`,
                    toolName: "Bash",
                  },
                  {
                    ruleContent: `python -c '${oversizedTail}'`,
                    toolName: "Bash",
                  },
                ],
                type: "addRules",
              },
            ],
          },
        },
      ],
      raw: { rawInput: { command: "write generated files" } },
    });

    expect(html).not.toContain('data-permission-rule-scopes="true"');
    expect(html).not.toContain('data-permission-rule-scope="exact"');
    expect(html).not.toContain("cat &gt; /tmp/sun.html");
    expect(html).not.toContain("HEREDOC_BODY_MUST_NOT_RENDER");
    expect(html).not.toContain("OVERSIZED_TAIL_MUST_NOT_RENDER");
    expect(html).not.toContain("仅此命令");
    expect(html).toContain("后续相同命令不再询问");
  });

  it("wraps a long prefix in the allow-always description position", () => {
    const html = renderPermissionDialog({
      type: "permission_request",
      taskId: "task-1",
      traceId: "trace-1",
      requestId: "request-long-prefix",
      description: "Run command",
      kind: "Bash",
      title: "Bash",
      options: [
        {
          optionId: "allow_project",
          kind: "allow_always",
          name: "Always allow in this project",
          response: {
            decision: "allow",
            permissionUpdates: [
              {
                behavior: "allow",
                rules: [
                  {
                    ruleContent: `pnpm run ${"unbroken-prefix-".repeat(20)}:*`,
                    toolName: "Bash",
                  },
                ],
                type: "addRules",
              },
            ],
          },
        },
      ],
      raw: { rawInput: { command: "run long command" } },
    });

    expect(html).toContain('data-permission-rule-prefixes="true"');
    expect(html).toContain('data-permission-rule-scopes="true"');
    expect(html).toContain("basis-48");
    expect(html).toContain("whitespace-pre-wrap");
    expect(html).toContain("break-all");
    expect(html).toContain('data-permission-rule-scope-truncated="true"');
    expect(html).not.toContain("后续相同命令不再询问");
  });

  it("shows a subagent source tag for delegated permission requests only", () => {
    const baseRequest: ZCodePermissionRequest = {
      type: "permission_request",
      taskId: "task-1",
      traceId: "trace-1",
      requestId: "request-1",
      description: "Run command",
      kind: "Bash",
      title: "Bash",
      options: [
        {
          optionId: "allow",
          kind: "allow",
          name: "Allow",
        },
      ],
      raw: {
        toolName: "Bash",
      },
    };

    const mainHtml = renderPermissionDialog(baseRequest);
    const subagentHtml = renderPermissionDialog({
      ...baseRequest,
      origin: SUBAGENT_ORIGIN,
    });

    expect(mainHtml).not.toContain('data-interaction-origin-badge="subagent"');
    expect(subagentHtml).toContain('data-interaction-origin-badge="subagent"');
    expect(subagentHtml).toContain("子智能体");
    expect(subagentHtml).toContain("来自子智能体：general-purpose");
  });

  it("names the subagent in the source tag when the origin carries a description", () => {
    const html = renderPermissionDialog({
      type: "permission_request",
      taskId: "task-1",
      traceId: "trace-1",
      requestId: "request-1",
      description: "Run command",
      kind: "Bash",
      title: "Bash",
      options: [{ optionId: "allow", kind: "allow", name: "Allow" }],
      raw: { toolName: "Bash" },
      // 动态工作流子代理的 origin（docs/dynamic-workflow/launch.md「Permissions inside a run」）。
      origin: {
        ...SUBAGENT_ORIGIN,
        agentType: "zcode-workflow",
        description: "reviewer (agent#1@0)",
      },
    });

    expect(html).toContain('data-interaction-origin-badge="subagent"');
    expect(html).toContain("子智能体 · reviewer (agent#1@0)");
    // 截断时完整文本留在 tooltip 里，且仍带 agentType。
    expect(html).toContain("来自子智能体：zcode-workflow · reviewer (agent#1@0)");
  });

  it("renders a compact implementation plan placeholder for switch mode requests", () => {
    const html = renderPermissionDialog({
      type: "permission_request",
      taskId: "task-1",
      traceId: "trace-1",
      requestId: "request-1",
      description: "Ready to code?",
      kind: "switch_mode",
      title: "Ready to code?",
      options: [
        {
          optionId: "code",
          kind: "allow_always",
          name: "是，并自动接受后续操作",
        },
      ],
      raw: {},
    });

    expect(html).toContain("实施计划");
    expect(html).not.toContain("ToolCall");
    expect(html).not.toContain("Ready to code?");
  });

  it("renders a compact implementation plan placeholder for ExitPlanMode requests", () => {
    const html = renderPermissionDialog({
      type: "permission_request",
      taskId: "task-1",
      traceId: "trace-1",
      requestId: "request-1",
      description: "ExitPlanMode changes session mode after user plan approval",
      kind: "ExitPlanMode",
      title: "ExitPlanMode",
      options: [
        {
          optionId: "allow",
          kind: "allow",
          name: "Allow",
        },
        {
          optionId: "deny",
          kind: "deny",
          name: "Deny",
        },
      ],
      raw: {
        toolName: "ExitPlanMode",
      },
    });

    expect(html).toContain("实施计划");
    expect(html).not.toContain("ToolCall");
    expect(html).not.toContain("ExitPlanMode changes session mode");
  });

  it("prefers custom ZCode Agent option names over generic kind labels", () => {
    const html = renderPermissionDialog({
      type: "permission_request",
      taskId: "task-1",
      traceId: "trace-1",
      requestId: "request-1",
      description: "Ready to code?",
      kind: "switch_mode",
      title: "Ready to code?",
      options: [
        {
          optionId: "code",
          kind: "allow_always",
          name: "是，并自动接受后续操作",
        },
        {
          optionId: "ask",
          kind: "allow_always",
          name: "是，但高风险操作仍逐次确认",
        },
        {
          optionId: "reject",
          kind: "reject_once",
          name: "否，先继续整理计划",
        },
      ],
      raw: {},
    });

    expect(html).toContain("是，并自动接受后续操作");
    expect(html).toContain("是，但高风险操作仍逐次确认");
    expect(html).toContain("否，先继续整理计划");
    expect(html).not.toContain("始终允许");
    expect(html).not.toContain("拒绝");
  });

  it("localizes GLM project-scoped generic permission options", () => {
    const html = renderPermissionDialog(
      {
        type: "permission_request",
        taskId: "task-1",
        traceId: "trace-1",
        requestId: "request-1",
        description: "Run shell command",
        kind: "execute",
        title: "Run shell command",
        options: [
          {
            optionId: "allow_project",
            kind: "allow_always",
            name: "Always allow in this project",
          },
        ],
        raw: {
          rawInput: {
            command: "printf '102384' >> test.md",
          },
        },
      },
      "glm",
    );

    expect(html).toContain("始终允许此命令");
    expect(html).toContain("后续相同命令不再询问");
    expect(html).not.toContain("Always allow in this project");
  });

  it("keeps non-Codex session-scoped permission option names provider-native", () => {
    const html = renderPermissionDialog(
      {
        type: "permission_request",
        taskId: "task-1",
        traceId: "trace-1",
        requestId: "request-1",
        description: "Run shell command",
        kind: "execute",
        title: "Run shell command",
        options: [
          {
            optionId: "allow_for_session",
            kind: "allow_always",
            name: "Allow for Session",
          },
        ],
        raw: {
          rawInput: {
            command: "printf '102384' >> test.md",
          },
        },
      },
      "claude",
    );

    expect(html).toContain("Allow for Session");
    expect(html).not.toContain("允许本会话");
  });

  it("renders file change previews with file display for add operations", () => {
    const html = renderPermissionDialog({
      type: "permission_request",
      taskId: "task-1",
      traceId: "trace-1",
      requestId: "request-1",
      description: "Apply patch",
      kind: "apply_patch",
      title: "Apply patch",
      options: [
        {
          optionId: "allow",
          kind: "allow_once",
          name: "允许",
        },
      ],
      raw: {
        changes: {
          "/Users/dev/ZCodeProject/demo/README.md": {
            type: "add",
            content: "\n",
          },
        },
      },
    });

    expect(html).toContain("README.md");
    expect(html).toContain("等待确认");
    expect(html).not.toContain("/Users/dev/ZCodeProject/demo/");
  });

  it("renders ZCode protocol Write input as an existing file preview", () => {
    const html = renderPermissionDialog({
      type: "permission_request",
      taskId: "task-1",
      traceId: "trace-1",
      requestId: "request-1",
      description: "Tool has side effects and requires approval",
      kind: "Write",
      title: "Write",
      options: [
        {
          optionId: "allow",
          kind: "allow_once",
          name: "允许",
        },
      ],
      raw: {
        requestId: "request-1",
        toolName: "Write",
        input: {
          file_path: "/Users/dev/ZCodeProject/demo/quicksort.js",
          content: "export function quicksort(items) {\n  return items;\n}\n",
        },
      },
    });

    expect(html).toContain("quicksort.js");
    expect(html).toContain("等待确认");
    expect(html).toContain("+3");
    expect(html).not.toContain("toolName");
    expect(html).not.toContain("file_path");
  });

  it("renders ZCode protocol Edit input as an existing file preview", () => {
    const html = renderPermissionDialog({
      type: "permission_request",
      taskId: "task-1",
      traceId: "trace-1",
      requestId: "request-1",
      description: "Tool has side effects and requires approval",
      kind: "Edit",
      title: "Edit",
      options: [
        {
          optionId: "allow",
          kind: "allow_once",
          name: "允许",
        },
      ],
      raw: {
        requestId: "request-1",
        toolName: "Edit",
        input: {
          file_path: "/Users/dev/ZCodeProject/demo/quicksort.js",
          old_string: "平均时间复杂度 O(n log n)",
          new_string: "平均时间复杂度 O(n log n)，最坏 O(n^2)",
        },
      },
    });

    expect(html).toContain("quicksort.js");
    expect(html).toContain("等待确认");
    expect(html).toContain("+1");
    expect(html).toContain("-1");
    expect(html).not.toContain("old_string");
    expect(html).not.toContain("new_string");
  });

  it("renders grouped file changes for multiple updates", () => {
    const html = renderPermissionDialog({
      type: "permission_request",
      taskId: "task-1",
      traceId: "trace-1",
      requestId: "request-1",
      description: "Apply patch",
      kind: "apply_patch",
      title: "Apply patch",
      options: [
        {
          optionId: "allow",
          kind: "allow_once",
          name: "允许",
        },
      ],
      raw: {
        changes: {
          "/Users/dev/ZCodeProject/demo/index.html": {
            type: "update",
            content: "<html></html>",
          },
          "/Users/dev/ZCodeProject/demo/styles.css": {
            type: "update",
            content: "body {}",
          },
          "/Users/dev/ZCodeProject/demo/script.js": {
            type: "update",
            content: "console.log('ok')",
          },
        },
      },
    });

    expect(html).toContain("等待确认");
    expect(html).toContain("index.html");
    expect(html).toContain("styles.css");
    expect(html).toContain("script.js");
    expect(html).not.toContain("/Users/dev/ZCodeProject/demo/");
  });

  it("不再承载聊天底部主列宽度和 summary 偏移", () => {
    const html = renderPermissionDialog({
      type: "permission_request",
      taskId: "task-1",
      traceId: "trace-1",
      requestId: "request-1",
      description: "Run shell command",
      kind: "execute",
      title: "Run shell command",
      options: [
        {
          optionId: "allow",
          kind: "allow_once",
          name: "允许",
        },
      ],
      raw: {
        rawInput: {
          command: "printf ok",
        },
      },
    });

    expect(html).toContain("Run shell command");
    expect(html).toContain("等待确认");
    expect(html).not.toContain("执行中");
    expect(html).not.toContain("translate-x");
    expect(html).not.toContain("max-w-3xl");
    expect(html).not.toContain("max-w-2xl");
  });

  it("renders Bash input description as the permission reason instead of a running state", () => {
    const html = renderPermissionDialog({
      type: "permission_request",
      taskId: "task-1",
      traceId: "trace-1",
      requestId: "request-bash-description",
      description: "High risk tools require explicit approval",
      kind: "Bash",
      title: "Bash",
      options: [
        {
          optionId: "allow",
          kind: "allow_once",
          name: "允许",
        },
      ],
      raw: {
        requestId: "request-bash-description",
        reason: "High risk tools require explicit approval",
        toolName: "Bash",
        input: {
          description: "Check package.json scripts",
          command: 'cat /Users/dev/test/z-m/package.json 2>/dev/null || echo "No package.json"',
        },
      },
    });

    expect(html).toContain("Check package.json scripts");
    expect(html).toContain("等待确认");
    expect(html).toContain("cat /Users/dev/test/z-m/package.json");
    expect(html).not.toContain("High risk tools require explicit approval");
    expect(html).not.toContain("执行中");
  });

  it("hides the generic high-risk policy reason when no tool description exists", () => {
    const html = renderPermissionDialog({
      type: "permission_request",
      taskId: "task-1",
      traceId: "trace-1",
      requestId: "request-high-risk-policy-reason",
      description: "High risk tools require explicit approval",
      kind: "Bash",
      title: "Bash",
      options: [
        {
          optionId: "allow",
          kind: "allow_once",
          name: "允许",
        },
      ],
      raw: {
        requestId: "request-high-risk-policy-reason",
        reason: "High risk tools require explicit approval",
        riskLevel: "high",
        toolName: "Bash",
        input: {
          command: "rm -rf ./generated",
        },
      },
    });

    expect(html).toContain("等待确认");
    expect(html).toContain("rm -rf ./generated");
    expect(html).not.toContain("High risk tools require explicit approval");
  });

  it("renders WebFetch permission requests as a URL summary instead of fallback JSON", () => {
    const url =
      "https://www.zhihu.com/search?q=%E6%99%BA%E8%B0%B1AI%20Agent%20%E9%9D%A2%E8%AF%95%E9%A2%98";
    const html = renderPermissionDialog({
      type: "permission_request",
      taskId: "task-1",
      traceId: "trace-1",
      requestId: "perm-webfetch",
      description: "Tool has side effects and requires approval",
      kind: "WebFetch",
      title: "WebFetch",
      options: [
        {
          optionId: "allow",
          kind: "allow_once",
          name: "允许",
        },
        {
          optionId: "deny",
          kind: "deny",
          name: "拒绝",
        },
      ],
      raw: {
        requestId: "perm-webfetch",
        toolName: "WebFetch",
        input: {
          url,
          prompt: "List all AI Agent / LLM application development interview questions mentioned",
        },
      },
    });

    expect(html).toContain(url);
    expect(html).toContain("等待确认");
    expect(html).not.toContain("Tool has side effects and requires approval");
    expect(html).not.toContain("List all AI Agent");
    expect(html).not.toContain("&quot;toolId&quot;");
    expect(html.match(/WebFetch/g)?.length ?? 0).toBeLessThanOrEqual(1);
  });

  it("renders MCP permission requests without the generic policy reason", () => {
    const toolName = "mcp__ios-simulator__ios_preflight";
    const reason = "Tool has side effects and requires approval";
    const html = renderPermissionDialog({
      type: "permission_request",
      taskId: "task-1",
      traceId: "trace-1",
      requestId: "perm-mcp",
      description: reason,
      kind: toolName,
      title: toolName,
      options: [
        {
          optionId: "allow",
          kind: "allow_once",
          name: "允许",
        },
        {
          optionId: "deny",
          kind: "deny",
          name: "拒绝",
        },
      ],
      raw: {
        requestId: "perm-mcp",
        toolCallId: "call-mcp",
        toolName,
        reason,
        riskLevel: "medium",
        input: {},
      },
    });

    expect(html.match(new RegExp(toolName, "g"))?.length ?? 0).toBe(1);
    expect(html).not.toContain(reason);
    expect(html).not.toContain("&quot;reason&quot;");
    expect(html).not.toContain("&quot;toolCallId&quot;");
  });

  it("keeps a specific MCP permission reason visible", () => {
    const toolName = "mcp__ios-simulator__ios_preflight";
    const reason = "The simulator must be booted before installing the app";
    const html = renderPermissionDialog({
      type: "permission_request",
      taskId: "task-1",
      traceId: "trace-1",
      requestId: "perm-mcp-specific-reason",
      description: reason,
      kind: toolName,
      title: toolName,
      options: [
        {
          optionId: "allow",
          kind: "allow_once",
          name: "允许",
        },
        {
          optionId: "deny",
          kind: "deny",
          name: "拒绝",
        },
      ],
      raw: {
        requestId: "perm-mcp-specific-reason",
        toolCallId: "call-mcp-specific-reason",
        toolName,
        reason,
        riskLevel: "medium",
        input: {},
      },
    });

    expect(html).toContain(reason);
  });

  it("keeps CUA macOS permission actions out of tool approval dialogs", () => {
    const toolName = "mcp__zcode-cua__request_access";
    const html = renderPermissionDialog(
      {
        type: "permission_request",
        taskId: "task-1",
        traceId: "trace-1",
        requestId: "perm-cua",
        description: "Tool has side effects and requires approval",
        kind: toolName,
        title: toolName,
        options: [
          {
            optionId: "allow",
            kind: "allow_once",
            name: "允许",
          },
          {
            optionId: "deny",
            kind: "deny",
            name: "拒绝",
          },
        ],
        raw: {
          requestId: "perm-cua",
          toolName,
          input: {
            permissions: ["accessibility"],
          },
        },
      },
      undefined,
    );

    expect(html).not.toContain("打开辅助功能设置");
    expect(html).not.toContain("ZCode Computer Use.app");
    expect(html).toContain("允许");
  });

  it("does not offer the Computer Use Helper Accessibility action for unrelated MCP permission requests", () => {
    const toolName = "mcp__ios-simulator__ios_preflight";
    const html = renderPermissionDialog(
      {
        type: "permission_request",
        taskId: "task-1",
        traceId: "trace-1",
        requestId: "perm-mcp",
        description: "Tool has side effects and requires approval",
        kind: toolName,
        title: toolName,
        options: [
          {
            optionId: "allow",
            kind: "allow_once",
            name: "允许",
          },
          {
            optionId: "deny",
            kind: "deny",
            name: "拒绝",
          },
        ],
        raw: {
          requestId: "perm-mcp",
          toolName,
          input: {},
        },
      },
      undefined,
    );

    expect(html).not.toContain("打开辅助功能设置");
    expect(html).not.toContain("ZCode Computer Use.app");
  });

  it("does not offer the Computer Use Helper Accessibility action for ordinary zcode-cua tool requests", () => {
    const toolName = "mcp__zcode-cua__left_click";
    const html = renderPermissionDialog(
      {
        type: "permission_request",
        taskId: "task-1",
        traceId: "trace-1",
        requestId: "perm-cua-click",
        description: "Tool has side effects and requires approval",
        kind: toolName,
        title: toolName,
        options: [
          {
            optionId: "allow",
            kind: "allow_once",
            name: "允许",
          },
          {
            optionId: "deny",
            kind: "deny",
            name: "拒绝",
          },
        ],
        raw: {
          requestId: "perm-cua-click",
          toolName,
          input: {
            target: { type: "coordinate", x: 10, y: 10, space: "screen" },
          },
        },
      },
      undefined,
    );

    expect(html).not.toContain("打开辅助功能设置");
    expect(html).not.toContain("ZCode Computer Use.app");
  });
});
