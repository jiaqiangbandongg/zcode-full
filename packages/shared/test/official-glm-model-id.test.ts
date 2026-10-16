import { describe, expect, it } from "vitest";
import { normalizeOfficialGlmModelId } from "../src/official-glm-model-id.js";
import { migrateLegacyOfficialGlmModelId } from "../src/legacy-model-provider-identity.js";

describe("官方 GLM ID 边界", () => {
  it("只规范化已知型号，不猜未知后缀", () => {
    expect(normalizeOfficialGlmModelId("glm-5.3-FLASH")).toBe("GLM-5.3-Flash");
    expect(normalizeOfficialGlmModelId("glm-4.7-flashx")).toBe("GLM-4.7-FlashX");
    expect(normalizeOfficialGlmModelId("glm-future-preview")).toBe("glm-future-preview");
    expect(normalizeOfficialGlmModelId("vendor/glm-5.3-flash")).toBe("vendor/glm-5.3-flash");
  });
  it("迁移只处理明确官方身份，不改任意个人 Provider", () => {
    for (const provider of [
      "builtin:zai-start-plan",
      "builtin:bigmodel-coding-plan",
      "account:zai-start-plan",
    ])
      expect(migrateLegacyOfficialGlmModelId(provider, "glm-5.3-flash")).toBe("GLM-5.3-Flash");
    for (const provider of ["openrouter", "my-provider", "zai-api", "account:zai-off-peak"])
      expect(migrateLegacyOfficialGlmModelId(provider, "glm-5.3-flash")).toBe("glm-5.3-flash");
  });
});
