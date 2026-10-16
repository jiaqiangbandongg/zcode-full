import {
  ModelConfigRules,
  ProviderConfigMap,
  type ProviderConfigLayerUpdate,
} from "@zcode/provider";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NodeModelSelectionConfigRepository,
  NodePersonalProviderConfigRepository,
} from "../src/index.js";

const roots: string[] = [];
const owners: NodePersonalProviderConfigRepository[] = [];
// Windows 无开发者模式时创建 symlink 会 EPERM；symlink 主题用例按能力探测跳过
const canCreateSymlink = await (async () => {
  const probeRoot = await mkdtemp(join(tmpdir(), "zcode-symlink-probe-"));
  try {
    await symlink(probeRoot, join(probeRoot, "link"), "dir");
    return true;
  } catch {
    return false;
  } finally {
    await rm(probeRoot, { force: true, recursive: true });
  }
})();
function selectionRepository(
  filePath: string,
  importLegacy?: () => Promise<ProviderConfigLayerUpdate | null>,
) {
  const personalRepository = new NodePersonalProviderConfigRepository({
    filePath,
    pollingIntervalMs: false,
    importLegacy,
  });
  owners.push(personalRepository);
  return new NodeModelSelectionConfigRepository({ personalRepository });
}

afterEach(async () => {
  owners.splice(0).forEach((owner) => owner.dispose());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("NodeModelSelectionConfigRepository", () => {
  it("imports a legacy configured default once when the new file is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-model-selection-config-"));
    roots.push(root);
    const filePath = join(root, "provider_config.json");
    const importLegacy = vi.fn(async () => ({
      providers: ProviderConfigMap.empty(),
      models: ModelConfigRules.empty(),
      defaultModelSelection: { providerId: "provider-a", modelId: "model-a" },
    }));
    const repository = selectionRepository(filePath, importLegacy);

    expect(await repository.read()).toEqual({
      providerId: "provider-a",
      modelId: "model-a",
    });
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({
      schemaVersion: 1,
      config: {
        providerConfigRules: { providerRules: [] },
        modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
        defaultModelSelection: { providerId: "provider-a", modelId: "model-a" },
      },
    });

    await repository.read();
    expect(importLegacy).toHaveBeenCalledOnce();
    repository.dispose();
  });

  it("saves and reloads a configured default", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-model-selection-config-"));
    roots.push(root);
    const filePath = join(root, "provider_config.json");
    const repository = selectionRepository(filePath);

    await repository.saveConfiguredDefault({
      providerId: "provider-b",
      modelId: "model-b",
      options: { reasoningLevel: "high" },
    });
    expect(await repository.read()).toEqual({
      providerId: "provider-b",
      modelId: "model-b",
      options: { reasoningLevel: "high" },
    });
    repository.dispose();
  });

  it("损坏 Personal 读取降级但保留原文件，禁止默认保存覆盖它", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-model-selection-config-"));
    roots.push(root);
    const filePath = join(root, "provider_config.json");
    await writeFile(filePath, "{not-json", "utf8");
    const repository = selectionRepository(filePath);

    await expect(repository.read()).resolves.toBeUndefined();
    await expect(
      repository.saveConfiguredDefault({ providerId: "p", modelId: "m" }),
    ).rejects.toThrow();
    await expect(readFile(filePath, "utf8")).resolves.toBe("{not-json");
    repository.dispose();
  });

  (canCreateSymlink ? it : it.skip)(
    "does not delete the target when reading fails before content can be decoded",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-model-selection-config-"));
      roots.push(root);
      const directory = join(root, "configured-default-directory");
      const filePath = join(root, "provider_config.json");
      await mkdir(directory);
      await symlink(directory, filePath, "dir");
      const repository = selectionRepository(filePath);

      await expect(repository.read()).resolves.toBeUndefined();
      expect((await lstat(filePath)).isSymbolicLink()).toBe(true);
      repository.dispose();
    },
  );
});
