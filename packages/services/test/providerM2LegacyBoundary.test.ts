import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const retiredProviderSources = [
  "../src/model-provider/codingPlanCache.ts",
  "../src/model-provider/repo/atomicFileRepo.ts",
  "../src/model-provider/repo/glmWorkspaceConfigRepo.ts",
  "../src/providers/codexModelOverride.ts",
  "../src/providers/providerSettingsJson.ts",
] as const;

describe("M2 Provider legacy boundary", () => {
  it.each(retiredProviderSources)("不再保留已退出的旧事实源 %s", async (relativePath) => {
    const filePath = fileURLToPath(new URL(relativePath, import.meta.url));

    await expect(access(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
