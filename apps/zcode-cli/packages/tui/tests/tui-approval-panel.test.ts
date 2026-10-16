import assert from "node:assert/strict";
import test from "node:test";
import type { PermissionBrokerRequest } from "@zcode/contracts";
import { OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME } from "@zcode/shared";
import { ApprovalPanel } from "../src/app-approval-panel.js";
import { createApprovalResult, decisionsForApproval } from "../src/app-approval.js";
import type { ApprovalPrompt } from "../src/app-model.js";

test("guarded renders only once/deny and rejects a forged project decision", () => {
  const approval = approvalPrompt({ command: "rm -rf fixture" });
  approval.request.approvalMode = "user-once";
  const lines = collectTextNodes(ApprovalPanel({ approval, contentWidth: 60 }));
  assert.ok(lines.some(line => line.text.includes("Allow once")));
  assert.ok(!lines.some(line => line.text.includes("Always allow")));
  assert.deepEqual(decisionsForApproval(approval.request), ["allow_once", "deny"]);
  assert.equal(createApprovalResult(approval.request, "allow_project").decision, "deny");
  assert.equal(createApprovalResult(approval.request, "allow_once").permissionUpdates, undefined);
});

test("renders approval prompts with wrapping-friendly layout", () => {
  const approval = approvalPrompt({
    command: "ls /tmp/*.{png,jpg,jpeg,PNG,JPG,JPEG} 2>/dev/null | head -20",
    description: "List recent image files in the temporary directory before choosing one.",
  });

  const panel = ApprovalPanel({
    approval,
    contentWidth: 38,
  });

  const panelStyle = elementStyle(panel);
  assert.equal((panelStyle.height as number) > 11, true);
  assert.equal(panelStyle.width, "100%");

  const lines = collectTextNodes(panel);
  const description = lines.find((line) => line.text.includes("List recent image files"));
  const preview = lines.find((line) => line.text.includes("ls /tmp"));
  const reason = lines.find((line) => line.text.includes("explicit approval"));
  const risk = lines.find((line) => line.text.includes("Risk high"));
  const allowOnce = lines.find((line) => line.text.includes("Allow once"));

  assert.ok(description);
  assert.ok(preview);
  assert.equal((preview.style.height as number) > 1, true);
  assert.equal(preview.style.width, "100%");
  assert.equal(preview.style.wrapMode, "word");
  assert.equal(reason, undefined);
  assert.equal(risk, undefined);
  assert.equal(preview.text.includes("description"), false);
  assert.equal(allowOnce?.style.height, 1);
  assert.equal(allowOnce?.style.wrapMode, "word");
});

test("renders and returns CLI-authoritative command scopes", () => {
  const approval = approvalPrompt({ command: "pnpm run lint --fix" });
  approval.request.suggestedPermissionUpdates = [
    {
      behavior: "allow",
      rules: [
        { ruleContent: "pnpm run lint:*", toolName: "Bash" },
        { ruleContent: "rm -rf ./generated", toolName: "Bash" },
      ],
      type: "addRules",
    },
  ];

  const lines = collectTextNodes(ApprovalPanel({ approval, contentWidth: 60 }));
  assert.ok(lines.some((line) => line.text === "Command prefix: pnpm run lint …"));
  assert.ok(lines.some((line) => line.text === "Exact command only: rm -rf ./generated"));

  const result = createApprovalResult(approval.request, "allow_project");
  assert.deepEqual(result.permissionUpdates, approval.request.suggestedPermissionUpdates);
});

test("discloses the full official Computer Use project grant and returns it unchanged", () => {
  const approval = approvalPrompt({ app_ref: { bundle_id: "com.apple.TextEdit" } });
  approval.request.toolName = "mcp__computer-use__left_click";
  approval.request.suggestedPermissionUpdates = [
    {
      behavior: "allow",
      rules: [{ toolName: OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME }],
      type: "addRules",
    },
  ];

  const lines = collectTextNodes(ApprovalPanel({ approval, contentWidth: 80 }));
  assert.ok(lines.some((line) => line.text.endsWith("Always allow Computer Use in this project")));
  assert.ok(
    lines.some(
      (line) => line.text === "Do not ask again for official Computer Use actions in this project",
    ),
  );

  const result = createApprovalResult(approval.request, "allow_project");
  assert.deepEqual(result.permissionUpdates, approval.request.suggestedPermissionUpdates);
});

function approvalPrompt(input: unknown): ApprovalPrompt {
  return {
    cleanup: () => undefined,
    reject: () => undefined,
    request: {
      input,
      mode: "build",
      reason: "explicit approval",
      requestedAt: new Date(0),
      requestId: "permission-1",
      riskLevel: "high",
      ruleId: "rule-1",
      sessionId: "session-1" as PermissionBrokerRequest["sessionId"],
      toolCallId: "tool-call-1" as PermissionBrokerRequest["toolCallId"],
      toolName: "Bash",
      traceId: "trace-1" as PermissionBrokerRequest["traceId"],
    },
    resolve: () => undefined,
    selectedDecision: "allow_once",
  };
}

function collectTextNodes(node: unknown): Array<{ style: Record<string, unknown>; text: string }> {
  const lines: ReturnType<typeof collectTextNodes> = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (typeof value !== "object" || value === null || !("props" in value)) return;
    const element = value as {
      props?: {
        children?: unknown;
        style?: Record<string, unknown>;
      };
      type?: unknown;
    };
    if (element.type === "text") {
      const text = collectTextLines(element.props?.children).join("");
      lines.push({ style: element.props?.style ?? {}, text });
    }
    visit(element.props?.children);
  };

  visit(node);
  return lines;
}

function collectTextLines(node: unknown): string[] {
  const lines: string[] = [];
  const visit = (value: unknown) => {
    if (typeof value === "string") {
      lines.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (typeof value === "object" && value !== null && "props" in value) {
      const element = value as { props?: { children?: unknown } };
      visit(element.props?.children);
    }
  };

  visit(node);
  return lines;
}

function elementStyle(node: unknown): Record<string, unknown> {
  if (typeof node !== "object" || node === null || !("props" in node)) return {};
  const element = node as {
    props?: {
      style?: Record<string, unknown>;
    };
  };
  return element.props?.style ?? {};
}
