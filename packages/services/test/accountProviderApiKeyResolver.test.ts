import { describe, expect, it } from "vitest";
import { pickOrgAndProject } from "#src/model-provider/accountProviderApiKeyResolver.js";

describe("pickOrgAndProject", () => {
  it("个人 Coding Plan 不会误选排在前面的 Team Plan 项目", () => {
    expect(
      pickOrgAndProject({
        organizations: [
          {
            organizationId: "org-team",
            organizationName: "团队组织",
            projects: [
              {
                projectId: "project-team",
                projectName: "团队项目",
                projectType: 2,
              },
            ],
          },
          {
            organizationId: "org-personal",
            organizationName: "个人组织",
            projects: [
              {
                projectId: "project-personal",
                projectName: "个人项目",
                projectType: 1,
              },
            ],
          },
        ],
      }),
    ).toEqual({
      organizationId: "org-personal",
      projectId: "project-personal",
    });
  });
});
