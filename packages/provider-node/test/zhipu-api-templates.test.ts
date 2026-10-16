import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseZCodeBuiltinModelConfigRules } from "@zcode/provider";

describe("Zhipu four manual API templates", () => {
  it.each(["zcode-builtin.json", "zcode-builtin.test.json"])(
    "%s 区分普通计费与套餐端点、签名准入、获取入口和媒体能力",
    async (filename) => {
      const release = JSON.parse(
        await readFile(new URL(`../../../config/provider/${filename}`, import.meta.url), "utf8"),
      );
      const templates = release.config.providerConfigRules.templateRules;
      for (const template of templates) {
        expect(
          new URL(template.config.access.apiKeyManagementUrl).protocol,
          template.templateId,
        ).toBe("https:");
        expect(template.config.access).not.toHaveProperty("teamApiKeyManagementUrl");
      }
      const rules = parseZCodeBuiltinModelConfigRules(release.config.modelConfigRules);
      for (const family of ["zai", "bigmodel"]) {
        for (const standard of [false, true]) {
          const templateId = `${family}-${standard ? "standard-" : ""}api`;
          const template = templates.find(
            (item: { templateId: string }) => item.templateId === templateId,
          );
          expect(template, templateId).toBeDefined();
          const label = `${family === "zai" ? "Z.ai" : "BigModel"} ${standard ? "API" : "Coding Plan"}`;
          expect(template.templateNameMap).toEqual({ "zh-CN": label, "en-US": label });
          const config = template.config;
          const host = family === "zai" ? "api.z.ai" : "open.bigmodel.cn";
          expect(config.api).toEqual({
            type: standard ? "openai-chat-completions" : "anthropic-messages",
            baseUrl: `https://${host}/api/${standard ? "paas/v4" : "anthropic"}`,
          });
          expect(config.access.type).toBe(standard ? "api-key" : "zhipu-coding-plan-api-key");
          expect(config.access.apiKeyManagementUrl).toBe(
            family === "zai"
              ? "https://z.ai/manage-apikey/apikey-list"
              : standard
                ? "https://bigmodel.cn/usercenter/proj-mgmt/apikeys"
                : "https://bigmodel.cn/coding-plan/personal/overview",
          );
          if (!standard) {
            expect(config.builtinModelIds).toEqual(["GLM-5.3", "GLM-5.3-Flash"]);
          }
          for (const modelId of ["GLM-5.3", "GLM-5.3-Flash"]) {
            const resolved = rules.resolve({
              templateId,
              providerId: "personal-fixture",
              modelId,
              apiType: config.api.type,
              baseUrl: config.api.baseUrl,
            });
            expect(config.builtinModelIds).toContain(modelId);
            expect(resolved.enabled).toBe(true);
            expect(resolved.properties?.inputFormat?.supportsImage).toBe(
              !standard || modelId.endsWith("Flash"),
            );
            expect(resolved.properties?.supportsNativeWebSearch).toBe(!standard);
            expect(resolved.properties?.supportsMidConversationSystem).toBe(!standard);
          }
        }
      }
    },
  );
});
