import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const retiredProviderSources = [
  "../src/app/official-mcp-trusted-origins.ts",
  "../src/app/model-catalog-overlay.ts",
  "../src/zcode-protocol/active-session-model-limits.ts",
] as const;

describe("M2 Bootstrap Provider legacy boundary", () => {
  it.each(retiredProviderSources)("不再保留无调用者的旧 Provider 边界 %s", async (path) => {
    const filePath = fileURLToPath(new URL(path, import.meta.url));
    await expect(access(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
