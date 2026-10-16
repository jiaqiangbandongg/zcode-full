import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Provider Settings 表单边界", () => {
  it("生产 UI 不再把旧 ModelProviderConfig 当作当前设置类型", async () => {
    const sourceRoot = join(import.meta.dirname, "../src");
    const sourceFiles = await collectSourceFiles(sourceRoot);
    const offenders: string[] = [];

    for (const filePath of sourceFiles) {
      const source = await readFile(filePath, "utf8");
      if (/\bModelProvider(?:Model)?Config\b/u.test(source)) {
        offenders.push(filePath.slice(sourceRoot.length + 1));
      }
    }

    expect(offenders).toEqual([]);
  });

  it("生产 UI 不再重新解释旧 Provider 启动可用性", async () => {
    const sourceRoot = join(import.meta.dirname, "../src");
    const sourceFiles = await collectSourceFiles(sourceRoot);
    const offenders: string[] = [];

    for (const filePath of sourceFiles) {
      const source = await readFile(filePath, "utf8");
      if (
        /\b(?:isModelProviderUsableForAgentStartup|hasUsableModelProviderForAgentStartup)\b/u.test(
          source,
        )
      ) {
        offenders.push(filePath.slice(sourceRoot.length + 1));
      }
    }

    expect(offenders).toEqual([]);
  });

  it("Renderer 编辑态直接复用正式 Config 字段，不再复刻旧 Store 结构", async () => {
    const formTypesPath = join(import.meta.dirname, "../src/lib/providerSettingsFormTypes.ts");
    const source = await readFile(formTypesPath, "utf8");

    expect(source).toContain("ProviderConfigObject");
    expect(source).toContain("ModelConfigObject");
    expect(source).not.toMatch(
      /\b(?:endpoints|defaultKind|kinds|modalities|ProviderOptionsPatch|createdAt|updatedAt)\b/u,
    );
    expect(source).not.toContain('from "@zcode/shared"');
  });

  it("API 格式展示不再保留模型级 kind 与 endpoint 编辑旁路", async () => {
    const apiFormatDisplayPath = join(
      import.meta.dirname,
      "../src/settings/model-provider-section/ProviderApiFormatSelect.tsx",
    );
    const source = await readFile(apiFormatDisplayPath, "utf8");

    expect(source).not.toMatch(
      /\b(?:ModelProviderKind|getDefaultModelProviderEndpointPathForKind|mapModelProviderApiFormatToKind|ProviderModelApiFormatMultiSelect|endpointPaths)\b/u,
    );
  });

  it("Provider 设置使用正式 ProviderApiType，不再引用旧 Store API Format 类型", async () => {
    const settingsRoot = join(import.meta.dirname, "../src/settings/model-provider-section");
    const sourceFiles = await collectSourceFiles(settingsRoot);
    const offenders: string[] = [];

    for (const filePath of sourceFiles) {
      if (/\bModelProviderApiFormat\b/u.test(await readFile(filePath, "utf8"))) {
        offenders.push(filePath.slice(settingsRoot.length + 1));
      }
    }

    expect(offenders).toEqual([]);
  });

  it.each(["ProviderConnectionModeSection", "useActiveModelProviderWorkspace"])(
    "Provider 设置不再保留无调用方的迁移 helper：%s",
    async (retiredHelper) => {
      const settingsRoot = join(import.meta.dirname, "../src/settings/model-provider-section");
      const sourceFiles = await collectSourceFiles(settingsRoot);
      const offenders: string[] = [];

      for (const filePath of sourceFiles) {
        if (new RegExp(`\\b${retiredHelper}\\b`, "u").test(await readFile(filePath, "utf8"))) {
          offenders.push(filePath.slice(settingsRoot.length + 1));
        }
      }

      expect(offenders).toEqual([]);
    },
  );

  it("模型交互不再受 Provider 级 modelsReadOnly 与表单 API Key 门禁", async () => {
    const settingsRoot = join(import.meta.dirname, "../src/settings/model-provider-section");
    const sourceFiles = await collectSourceFiles(settingsRoot);
    const source = (
      await Promise.all(sourceFiles.map((filePath) => readFile(filePath, "utf8")))
    ).join("\n");

    expect(source).not.toContain("modelsReadOnly");
    expect(source).not.toMatch(/model\.executable\s*&&\s*apiKeyValue\.trim/u);
  });
});

async function collectSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const filePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectSourceFiles(filePath)));
    } else if (/\.(?:ts|tsx)$/u.test(entry.name)) {
      files.push(filePath);
    }
  }
  return files;
}
