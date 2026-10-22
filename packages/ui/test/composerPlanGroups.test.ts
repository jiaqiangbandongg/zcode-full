import type { ProviderSettingsView } from "@zcode/services";
import { describe, expect, it } from "vitest";
import { buildComposerPlanGroups, composerConnectionKey } from "@/lib/composerPlanGroups.js";
import { BUILTIN_MODEL_PROVIDER_IDS as IDS } from "@zcode/shared";
const personal = {
  key: `registry-provider:${IDS.bigmodelIndividualCodingPlan}`,
  label: "BigModel",
  labelBadge: "Individual",
  items: [{ key: "m", value: "m", name: "GLM-5.3" }],
};
const team = {
  ...personal,
  key: `registry-provider:${IDS.bigmodelTeamCodingPlan}`,
  labelBadge: "Team",
};
const api = { key: "api", label: "DeepSeek", labelBadge: "API", items: [] };
const product = {
  family: "bigmodel" as const,
  productId: "p",
  subscribed: true,
  teamProjects: [
    { organizationId: "o", projectId: "j", organizationName: "Team One" },
    { organizationId: "o2", projectId: "j2", organizationName: "Team Two" },
  ],
};
describe("Composer concrete team provider rows", () => {
  it.each(["unavailable", "unknown", "available", undefined] as const)(
    "按 Provider 权威状态过滤菜单：%s",
    (availability) => {
      const settings = {
        providers: [
          { providerId: IDS.bigmodelTeamCodingPlan, accountState: { availability } },
          { providerId: IDS.bigmodelIndividualCodingPlan, accountState: { availability } },
        ],
      } as unknown as ProviderSettingsView;
      const result = buildComposerPlanGroups([personal, team, api], [product], settings);
      expect(result.map((g) => g.key)).toEqual(
        availability === "unavailable"
          ? [expect.any(String), expect.any(String), api.key]
          : [personal.key, expect.any(String), expect.any(String), api.key],
      );
    },
  );
  it.each([true, false])(
    "当前团队不可用只隐藏该身份，其他团队仍可选（目录已到达：%s）",
    (hasCatalog) => {
      const selection = {
        kind: "team-coding-plan" as const,
        productId: "p",
        organizationId: "o",
        projectId: "j",
      };
      const settings = {
        providers: [
          {
            providerId: IDS.bigmodelTeamCodingPlan,
            enabled: true,
            effectiveConfig: {
              access: { type: "zhipu-account", accountType: "bigmodel", mode: "team-coding-plan" },
              api: { type: "anthropic-messages" },
            },
            accountState: { availability: "unavailable" },
          },
        ],
      } as unknown as ProviderSettingsView;
      const groups = buildComposerPlanGroups(
        hasCatalog ? [personal, team, api] : [personal, api],
        [product],
        settings,
        "glm",
        {},
        { bigmodel: selection },
      );
      expect(groups.some((g) => g.key === composerConnectionKey("bigmodel", selection))).toBe(
        false,
      );
      const other = groups.find((g) => g.labelBadge === "Team Two");
      expect(other?.connection?.selection).toEqual({
        kind: "team-coding-plan",
        productId: "p",
        organizationId: "o2",
        projectId: "j2",
      });
      expect(other?.connection?.disabled).not.toBe(true);
    },
  );
  it.each([
    ["个人", "团队"],
    ["Individual", "Team"],
  ])("补充的非激活个人套餐复用当前语言 %s", (personalLabel, teamLabel) => {
    const settings = {
      providers: [
        {
          providerId: IDS.bigmodelIndividualCodingPlan,
          enabled: true,
          effectiveConfig: {
            access: {
              type: "zhipu-account",
              accountType: "bigmodel",
              mode: "individual-coding-plan",
              entitled: true,
            },
            api: { type: "anthropic-messages" },
          },
          accountState: { availability: "available", entitled: true },
        },
      ],
    } as unknown as ProviderSettingsView;
    const result = buildComposerPlanGroups([team, api], [product], settings, "glm", {
      codingPlanBadgeLabel: personalLabel,
      teamPlanBadgeLabel: teamLabel,
    });
    expect(result[0]?.labelBadge).toBe(personalLabel);
    expect(result[1]?.labelBadge).toBe("Team One");
  });
  it("每个完整已购团队直接成行，保留品牌与真实标签，API 不归并", () => {
    const groups = buildComposerPlanGroups([personal, team, api], [product]);
    expect(groups.map((g) => [g.label, g.labelBadge])).toEqual([
      ["BigModel", "Individual"],
      ["BigModel", "Team One"],
      ["BigModel", "Team Two"],
      ["DeepSeek", "API"],
    ]);
    expect(groups[1]?.connection?.selection).toEqual({
      kind: "team-coding-plan",
      productId: "p",
      organizationId: "o",
      projectId: "j",
    });
    expect(groups[3]).toBe(api);
  });
  it("相同名称不同身份保留，重复身份去重，不展示未购买或残缺团队", () => {
    const same = {
      ...product,
      teamProjects: product.teamProjects.map((p) => ({ ...p, organizationName: "Same" })),
    };
    const groups = buildComposerPlanGroups(
      [personal, team, api],
      [
        same,
        same,
        { ...product, subscribed: false },
        {
          ...product,
          productId: "bad",
          teamProjects: [{ organizationId: "o", projectId: "", organizationName: "Bad" }],
        },
      ],
    );
    expect(groups.filter((g) => g.connection?.selection?.kind === "team-coding-plan")).toHaveLength(
      2,
    );
    expect(groups[1]?.key).not.toBe(groups[2]?.key);
  });
  it("当前团队目录暂未到达时保留原团队行，不伪装为个人", () => {
    expect(buildComposerPlanGroups([personal, team, api], []).map((g) => g.key)).toEqual([
      personal.key,
      team.key,
      api.key,
    ]);
  });
  it("未选团队额度未知时仍可由已购目录发现，Agent 格式不兼容时隐藏", () => {
    const settings = {
      providers: [
        {
          providerId: IDS.bigmodelTeamCodingPlan,
          enabled: true,
          effectiveConfig: {
            access: { type: "zhipu-account", accountType: "bigmodel", mode: "team-coding-plan" },
            api: { type: "anthropic-messages" },
          },
          accountState: { availability: "unknown", entitled: false },
        },
      ],
    } as unknown as ProviderSettingsView;
    expect(
      buildComposerPlanGroups([personal, api], [product], settings).filter(
        (g) => g.connection?.selection?.kind === "team-coding-plan",
      ),
    ).toHaveLength(2);
    expect(
      buildComposerPlanGroups([personal, api], [product], settings, "codex").filter(
        (g) => g.connection?.selection?.kind === "team-coding-plan",
      ),
    ).toHaveLength(0);
  });
  it("隐藏明确不可用团队，不回退为泛化 Team 行；unknown 和可用项目保留", () => {
    const unavailable = {
      ...product,
      teamProjects: product.teamProjects.map((p) => ({ ...p, apiKeyStatus: "unavailable" })),
    };
    expect(buildComposerPlanGroups([personal, team, api], [unavailable]).map((g) => g.key)).toEqual(
      [personal.key, api.key],
    );
    const mixed = {
      ...product,
      apiKeyStatus: "unavailable",
      teamProjects: [
        { ...product.teamProjects[0]!, apiKeyStatus: "unknown" },
        { ...product.teamProjects[1]!, apiKeyStatus: "available" },
      ],
    };
    expect(
      buildComposerPlanGroups([personal, team, api], [mixed]).filter(
        (g) => g.connection?.selection?.kind === "team-coding-plan",
      ),
    ).toHaveLength(2);
    expect(
      buildComposerPlanGroups(
        [personal, team, api],
        [{ ...product, apiKeyStatus: "unavailable" }],
      ).map((g) => g.key),
    ).toEqual([personal.key, api.key]);
  });
});
