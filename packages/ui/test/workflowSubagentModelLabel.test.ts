// 子代理模型的词（docs/dynamic-workflow/presentation.md）：run 上存的是规范串
// `providerId/modelId[$reasoningLevel]`，那是给机器回填用的。屏幕上说的是模型名——拼名规则
// 直接复用模型菜单那一条，思考强度复用思考控件的词。这里钉住的就是这张对照表本身。
import { describe, expect, it } from "vitest";
import {
  describeWorkflowSubagentModel,
  workflowActorModelLabels,
  workflowSubagentModelCardLabel,
  workflowSubagentModelText,
  workflowSubagentModelTooltip,
} from "@/components/workflow-timeline/subagent-model-label.js";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

/** 与 IntlProvider 同形的极简 formatMessage：查表 + `{key}` 替换。 */
function formatter(messages: Record<string, string>) {
  return ({ id }: { id: string }, values?: Record<string, string | number>): string => {
    let message = messages[id] ?? id;
    for (const [key, value] of Object.entries(values ?? {})) {
      message = message.replaceAll(`{${key}}`, String(value));
    }
    return message;
  };
}

const en = formatter(enUS);
const zh = formatter(zhCN);

// 团队套餐的 provider id 就是一串十六进制：这是这次改动的起点，它绝不能出现在屏幕上。
const TEAM_PLAN_PROVIDER = "4fc7f541-2382-4c32-be11-f021b8d7ed1d";

describe("describeWorkflowSubagentModel", () => {
  it("内置家族只说模型名，档位单独成词（zh 说「高」，en 说「High」）", () => {
    const canonical = "account:zai-team-coding-plan/GLM-5.3-Flash$high";
    // 连接名属于产品固定入口，就算查得到也不拼进去。
    const providerName = () => "Coding Plan";

    expect(describeWorkflowSubagentModel(canonical, { formatMessage: zh, providerName })).toEqual({
      canonical,
      level: "高",
      name: "GLM-5.3-Flash",
    });
    expect(describeWorkflowSubagentModel(canonical, { formatMessage: en, providerName })).toEqual({
      canonical,
      level: "High",
      name: "GLM-5.3-Flash",
    });
  });

  it("没有档位就没有第二段", () => {
    expect(
      describeWorkflowSubagentModel(`${TEAM_PLAN_PROVIDER}/GLM-5.3-Highspeed`, {
        formatMessage: en,
      }),
    ).toEqual({
      canonical: `${TEAM_PLAN_PROVIDER}/GLM-5.3-Highspeed`,
      name: "GLM-5.3-Highspeed",
    });
  });

  it("自定义 provider 显示「名字/模型」，名字来自会话的模型清单", () => {
    expect(
      describeWorkflowSubagentModel("myproxy/glm-4.7$medium", {
        formatMessage: zh,
        providerName: (providerId) => (providerId === "myproxy" ? "MyProxy" : undefined),
      }),
    ).toEqual({
      canonical: "myproxy/glm-4.7$medium",
      level: "中",
      name: "MyProxy/glm-4.7",
    });
  });

  it("provider 解析不到（已删除 / 没有名字）时取串里的 modelId，绝不显示 provider id", () => {
    const label = describeWorkflowSubagentModel(`${TEAM_PLAN_PROVIDER}/GLM-5.3-Flash$high`, {
      formatMessage: en,
    });

    expect(label.name).toBe("GLM-5.3-Flash");
    expect(label.name).not.toContain(TEAM_PLAN_PROVIDER);
  });

  it("清单把 provider 名回退成了 provider id 时，当作没查到", () => {
    // zcodeSessionSettingsToConfigOptions 在没有 providerLabel 时会把 id 当名字塞回来。
    const label = describeWorkflowSubagentModel(`${TEAM_PLAN_PROVIDER}/GLM-5.3-Flash`, {
      formatMessage: en,
      providerName: (providerId) => providerId,
    });

    expect(label.name).toBe("GLM-5.3-Flash");
  });

  it("自定义模型的展示态值 custom:provider:model 同样认得", () => {
    expect(
      describeWorkflowSubagentModel("custom:myproxy:glm-4.7", {
        formatMessage: en,
        providerName: () => "MyProxy",
      }).name,
    ).toBe("MyProxy/glm-4.7");
  });

  it("词表里没有的档位原样显示（provider 自己的档位名）", () => {
    expect(
      describeWorkflowSubagentModel("myproxy/glm-4.7$turbo", { formatMessage: en }).level,
    ).toBe("turbo");
  });

  it("串不成形也不抛：砍掉 provider 段与档位后缀，剩下的就是人能读的那截", () => {
    expect(describeWorkflowSubagentModel("glm-4.7", { formatMessage: en }).name).toBe("glm-4.7");
  });
});

describe("子代理模型的成句与 tooltip", () => {
  const label = describeWorkflowSubagentModel(`${TEAM_PLAN_PROVIDER}/GLM-5.3-Flash$high`, {
    formatMessage: en,
  });

  it("确认窗那一句把强度接在模型名后面", () => {
    expect(workflowSubagentModelText(en, label)).toBe("GLM-5.3-Flash · thinking High");
    expect(
      workflowSubagentModelText(
        zh,
        describeWorkflowSubagentModel(label.canonical, { formatMessage: zh }),
      ),
    ).toBe("GLM-5.3-Flash · 思考 高");
  });

  it("tooltip 一句解释 + 换行 + 规范串：规范串只住在这里", () => {
    expect(workflowSubagentModelTooltip(en, label)).toBe(
      `Subagents run on GLM-5.3-Flash · thinking High. The main agent stays on the session model.\n${label.canonical}`,
    );
  });

  it("卡与侧板只取模型名，强度留给 tooltip；没指定过模型就整段缺席", () => {
    expect(workflowSubagentModelCardLabel(label.canonical, { formatMessage: en })).toEqual({
      name: "GLM-5.3-Flash",
      title: workflowSubagentModelTooltip(en, label),
    });
    expect(workflowSubagentModelCardLabel(undefined, { formatMessage: en })).toBeUndefined();
  });
});

describe("workflowActorModelLabels", () => {
  it("只收点名了模型的子代理，按 siteId@ordinal 索引；名字不带 providerId，规范串原样", () => {
    const labels = workflowActorModelLabels(
      [
        { siteId: "actor#1", ordinal: 1, model: `${TEAM_PLAN_PROVIDER}/GLM-5.3-Flash$high` },
        { siteId: "actor#1", ordinal: 2 },
        { siteId: "actor#2", ordinal: 1, model: "zhipu/GLM-5.3" },
      ],
      { formatMessage: en },
    );
    expect([...labels.keys()]).toEqual(["actor#1@1", "actor#2@1"]);
    expect(labels.get("actor#1@1")).toEqual({
      name: "GLM-5.3-Flash",
      canonical: `${TEAM_PLAN_PROVIDER}/GLM-5.3-Flash$high`,
    });
    expect(labels.get("actor#1@1")?.name).not.toContain(TEAM_PLAN_PROVIDER);
  });

  it("没有 run（静态图）即空表", () => {
    expect(workflowActorModelLabels(undefined, { formatMessage: en }).size).toBe(0);
  });
});
