import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const retiredProviderSources = [
  "../src/lib/workspaceModelMirror.ts",
] as const;

describe("M2 Renderer Provider legacy boundary", () => {
  it.each(retiredProviderSources)("不再保留已退出的旧模型镜像 %s", async (relativePath) => {
    const filePath = fileURLToPath(new URL(relativePath, import.meta.url));
    await expect(access(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
