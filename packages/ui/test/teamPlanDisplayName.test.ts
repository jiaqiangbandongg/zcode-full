import { describe, expect, it } from "vitest";
import { formatTeamPlanDisplayName } from "@/lib/teamPlanDisplayName.js";

describe("formatTeamPlanDisplayName", () => {
  it("优先只显示组织名称", () => {
    expect(
      formatTeamPlanDisplayName({
        organizationId: "123245",
        organizationName: "Organization",
        projectId: "project-a",
        projectName: "Project",
      }),
    ).toBe("Organization");
  });

  it("没有组织名称时不兜底显示 ID 或项目信息", () => {
    expect(
      formatTeamPlanDisplayName({
        organizationId: "123245",
        projectId: "project-a",
        projectName: "Project",
      }),
    ).toBeNull();
  });
});
