import { describe, expect, it } from "vitest";
import {
  ProviderConfig,
  ProviderConfigMap,
  parsePersonalProviderConfigMap,
  parseZCodeBuiltinProviderConfigRules,
  resolveProviderTemplateName,
} from "../src/index.js";

describe("Todo104 Provider 规则身份与内容分离", () => {
  it("模板索引不依赖声明顺序，身份/名称只在规则层序列化", () => {
    const source = {
      providerRules: [
        {
          providerId: "account:test",
          templateId: "template",
          providerName: "实例",
          config: { group: "zai-family" },
        },
      ],
      templateRules: [
        {
          templateId: "template",
          templateNameMap: { "zh-CN": "模板", "en-US": "Template" },
          config: { builtinModelIds: ["m"] },
        },
      ],
    };
    const parsed = parseZCodeBuiltinProviderConfigRules(source);
    expect(parsed.providers.toJSON()).toEqual(source.providerRules);
    expect(parsed.providerTemplates.toJSON()).toEqual(source.templateRules);
    expect(parsed.providers.get("account:test")?.toJSON()).toEqual({ group: "zai-family" });
    const template = parsed.providerTemplates.get("template")!;
    expect(resolveProviderTemplateName("template", template, "zh-CN")).toBe("模板");
    expect(
      resolveProviderTemplateName("template", { templateNameMap: { "en-US": "English" } }, "zh-CN"),
    ).toBe("English");
    expect(resolveProviderTemplateName("template", { templateNameMap: {} }, "zh-CN")).toBe(
      "template",
    );
  });

  it("只改 config 的成员/排序不能丢掉同一规则上的名称和模板关系", () => {
    const source = {
      providerRules: [
        {
          providerId: "custom:test",
          templateId: "t",
          providerName: "My Provider",
          config: { personalModelIds: ["m"] },
        },
      ],
    };
    const providers = parsePersonalProviderConfigMap(source);
    const next = providers.set("custom:test", providers.get("custom:test")!.withModelOrder(["m"]));
    expect(next.getRule("custom:test")).toMatchObject({
      providerId: "custom:test",
      templateId: "t",
      providerName: "My Provider",
    });
    expect(next.toJSON()).toEqual([
      { ...source.providerRules[0], config: { personalModelIds: ["m"], modelOrder: ["m"] } },
    ]);
    expect(
      next.mapConfigs((config) => config.withPersonalModelIds(["n"])).getRule("custom:test")
        ?.providerName,
    ).toBe("My Provider");
    expect(next.reorder(["custom:test"]).toJSON()).toEqual(next.toJSON());
    expect(providers.get("custom:test")?.modelOrder).toBeUndefined();
  });

  it("跨来源正常覆盖，外层 null 清除与缺省继承分开；同来源重复拒绝", () => {
    const a = parsePersonalProviderConfigMap({
      providerRules: [
        {
          providerId: "p",
          templateId: "t",
          providerName: "A",
          config: { personalModelIds: ["m"] },
        },
      ],
    });
    const b = parsePersonalProviderConfigMap({
      providerRules: [{ providerId: "p", providerName: null, config: { modelOrder: ["m"] } }],
    });
    expect(a.overlay(b).toJSON()).toEqual([
      {
        providerId: "p",
        templateId: "t",
        providerName: null,
        config: { personalModelIds: ["m"], modelOrder: ["m"] },
      },
    ]);
    expect(() =>
      parsePersonalProviderConfigMap({
        providerRules: [
          { providerId: "p", config: {} },
          { providerId: "p", config: {} },
        ],
      }),
    ).toThrow();
    // Account 仍可从内部事实组装纯配置；该快捷构造不在磁盘建立第二种格式。
    const account = new ProviderConfigMap([
      ["p", new ProviderConfig({ builtinModelIds: ["dynamic"] })],
    ]);
    expect(a.overlay(account).getRule("p")?.providerName).toBe("A");
    expect(a.overlay(account).get("p")?.builtinModelIds).toEqual(["dynamic"]);
  });
});
