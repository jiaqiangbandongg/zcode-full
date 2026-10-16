import { describe, expect, it } from "vitest";

import { sanitizeConversationShareIssues } from "../src/conversation-share/conversationShare.js";

describe("sanitizeConversationShareIssues", () => {
  it("保留正常 issue 的 artifactDisplayName", () => {
    const result = sanitizeConversationShareIssues([
      {
        code: "artifact_type_not_allowed",
        scope: "artifact",
        artifactDisplayName: "report.pdf",
        artifactType: "pdf",
        extension: "pdf",
        mimeType: "application/pdf",
      },
    ]);

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ artifactDisplayName: "report.pdf" });
    expect(result.omittedIssueCount).toBe(0);
  });

  // Bug 根因：displayName 含路径/URL 或超长时，此前整条 issue 返回 null 被过滤——脱敏目标是
  // 不泄露路径，而不是丢掉整条诊断。改为只剥离该字段，保留 code/scope 等定位信息。
  it.each([
    ["相对路径", "src/app.ts"],
    ["反斜杠路径", "src\\app.ts"],
    ["URL", "https://evil.example/report.pdf"],
    ["超过 128 字符", `${"a".repeat(129)}.pdf`],
  ])("displayName 是%s时只剥离该字段，不丢弃整条 issue", (_label, displayName) => {
    const result = sanitizeConversationShareIssues([
      {
        code: "artifact_type_not_allowed",
        scope: "artifact",
        artifactDisplayName: displayName,
        artifactType: "pdf",
        extension: "pdf",
        mimeType: "application/pdf",
      },
    ]);

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ code: "artifact_type_not_allowed", scope: "artifact" });
    expect(result.issues[0]).not.toHaveProperty("artifactDisplayName");
    expect(result.omittedIssueCount).toBe(0);
  });

  it("超过 5 条时仍按上限截断并报告省略数", () => {
    const issues = Array.from({ length: 7 }, (_, index) => ({
      code: "artifact_type_not_allowed" as const,
      scope: "artifact" as const,
      artifactDisplayName: `report-${index}.pdf`,
    }));
    const result = sanitizeConversationShareIssues(issues);

    expect(result.issues).toHaveLength(5);
    expect(result.issueCount).toBe(7);
    expect(result.omittedIssueCount).toBe(2);
  });
});
