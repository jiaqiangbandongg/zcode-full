import { readdir, readFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const productionRoots = [
  "packages/provider/src",
  "packages/provider-node/src",
  "packages/services/src",
  "packages/ui/src",
  "packages/desktop/src",
  "packages/shared/src",
  "apps/zcode-cli/packages/adapters/src",
  "apps/zcode-cli/packages/bootstrap/src",
  "apps/zcode-cli/packages/cli/src",
  "apps/zcode-cli/packages/contracts/src",
  "apps/zcode-cli/packages/core/src",
  "apps/zcode-cli/packages/tui/src",
] as const;

const legacyDtoOwners = new Set([
  "packages/services/src/model-provider/legacyModelProviderSerialized.ts",
  "packages/services/src/model-provider/legacyZCodeConfigProviderReader.ts",
  "packages/services/src/model-provider/legacyPersonalProviderConfigImporter.ts",
  "packages/services/src/model-provider/providerConfigRuntime.ts",
]);
const legacyDtoTestOwners = new Set([
  "packages/services/test/legacyZCodeConfigProviderReader.test.ts",
  "packages/services/test/legacyPersonalProviderConfigImporter.test.ts",
  "packages/services/test/providerConfigRuntime.test.ts",
  "packages/ui/test/providerSettingsFormBoundary.test.ts",
]);
const legacyApiFormatOwners = new Set([
  "packages/services/src/model-provider/legacyModelProviderSerialized.ts",
  "packages/services/src/model-provider/legacyZCodeConfigProviderReader.ts",
]);
const testRoots = [
  "packages/desktop/test",
  "packages/services/test",
  "packages/shared/test",
  "packages/ui/test",
] as const;

describe("M2 completion boundary", () => {
  it("旧 Provider DTO 只属于一次性物理迁移边界", async () => {
    const matches = await findProductionFilesMatching(/\bModelProviderConfig\b/u);
    expect(matches).toEqual([...legacyDtoOwners].sort());
  });

  it("非迁移测试不再以旧 Provider DTO 组织夹具", async () => {
    const matches = await findFilesMatching(testRoots, /\bModelProviderConfig\b/u);
    expect(matches).toEqual([...legacyDtoTestOwners].sort());
  });

  it("生产实现不再读取旧 Provider Store 路径", async () => {
    expect(await findProductionFilesContaining("model-providers.json")).toEqual([]);
  });

  it("正式 Provider 消费链路不再使用旧 API format 类型", async () => {
    const matches = await findProductionFilesMatching(/\bModelProviderApiFormat\b/u);
    expect(matches).toEqual([...legacyApiFormatOwners].sort());
  });

  it("旧 Runtime Model Config 只属于一次性导入与兼容解析边界", async () => {
    const matches = await findProductionFilesMatching(/\bRuntimeModelConfig\b/u);
    expect(matches).toEqual([]);
  });

  it("模型名硬编码缺省值不能重新进入 Process Registry 与正式 Model", async () => {
    const matches = await findProductionFilesMatching(
      /\b(?:resolveModelCapabilityDefaults|createDefaultModelCapability|applyModelCapabilityDefaults)\b/u,
    );
    expect(matches).toEqual([]);
  });

  it.each([
    "ZCodeProviderRegistrySnapshot",
    "workspace/updateProviderRegistry",
    "RuntimeModelOverlayManager",
    "ModelProviderService",
    "modelProviderServiceStorage",
    "providerSettingsLegacyProjection",
    "workspaceModelCatalogs",
    "workspaceModelMirror",
    "setModelCatalogOverlay",
    "ZCodeWorkspaceModelCatalogState",
    "setProviderRuntimeHeaders",
    "session/updateRuntimeModelConfig",
    "hasProcessProviderRegistry",
    "bootstrapModelConfig",
    "includeLegacyProviderModels",
    "BUILTIN_MODEL_PROVIDER_ORDER",
    "ModelProviderDisplayOrderState",
    "Workspace model catalog",
    "workspace model catalog",
    "appliedProviderRevision",
    "providerRevision",
    "createRuntimeAiSdkModelRegistryConfig",
    "modelCatalog: options.modelCatalog",
  ])("生产源码不再出现已退出边界 %s", async (retiredBoundary) => {
    expect(await findProductionFilesContaining(retiredBoundary)).toEqual([]);
  });

  it.each([
    "isModelProviderEnabled",
    "getModelProviderModelId",
    "getModelProviderModelLabel",
    "findModelProviderModel",
    "mapModelProviderKindToSupportedFormat",
    "resolveModelSupportedFormatsForModel",
    "hasRemoteProviderModelFacts",
    "migrateLegacyOpenAiCompatibleReasoningOptions",
    "isSystemDisabledCodingPlanProvider",
    "isUserDisabledCodingPlanProvider",
  ])("生产源码不再公开或消费无有效调用方的旧 helper %s", async (retiredHelper) => {
    expect(
      await findProductionFilesMatching(new RegExp(`\\b${escapeRegExp(retiredHelper)}\\b`, "u")),
    ).toEqual([]);
  });
});

async function findProductionFilesContaining(needle: string): Promise<string[]> {
  return findProductionFilesMatching(new RegExp(escapeRegExp(needle), "u"));
}

async function findProductionFilesMatching(pattern: RegExp): Promise<string[]> {
  return findFilesMatching(productionRoots, pattern);
}

async function findFilesMatching(roots: readonly string[], pattern: RegExp): Promise<string[]> {
  const files = (
    await Promise.all(roots.map((root) => collectSourceFiles(resolve(repositoryRoot, root))))
  ).flat();
  const matches: string[] = [];
  for (const file of files) {
    if (pattern.test(await readFile(file, "utf-8"))) {
      // 路径作为跨平台模块标识，统一 POSIX 分隔符比较（Windows readdir 产出 \）。
      matches.push(relative(repositoryRoot, file).replaceAll("\\", "/"));
    }
  }
  return matches.sort();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function collectSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return collectSourceFiles(path);
      return extname(entry.name) === ".ts" || extname(entry.name) === ".tsx" ? [path] : [];
    }),
  );
  return files.flat();
}
