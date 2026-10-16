import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { materializeBundledZCodeBuiltinProviderConfig } from "../src/bundledZCodeBuiltinProviderConfig.js";

describe("materializeBundledZCodeBuiltinProviderConfig", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("在环境固定路径物化 ZCode Built-in Provider Config，并复用相同内容", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "zcode-remote-provider-config-"));
    tempDirs.push(runtimeRoot);
    const content = emptyRelease(1);

    const firstPath = await materializeBundledZCodeBuiltinProviderConfig({
      environmentConfigRoot: runtimeRoot,
      content,
    });
    const secondPath = await materializeBundledZCodeBuiltinProviderConfig({
      environmentConfigRoot: runtimeRoot,
      content,
    });

    expect(secondPath).toBe(firstPath);
    expect(firstPath).toBe(
      join(runtimeRoot, "runtime", "provider", "bundled", "zcode-builtin.json"),
    );
    await expect(readFile(firstPath, "utf8")).resolves.toBe(`${content}\n`);
  });

  it("内容变化时在固定路径替换资源副本", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "zcode-remote-provider-config-"));
    tempDirs.push(runtimeRoot);
    const firstContent = emptyRelease(1);
    const secondContent = emptyRelease(2);

    const firstPath = await materializeBundledZCodeBuiltinProviderConfig({
      environmentConfigRoot: runtimeRoot,
      content: firstContent,
    });
    const secondPath = await materializeBundledZCodeBuiltinProviderConfig({
      environmentConfigRoot: runtimeRoot,
      content: secondContent,
    });

    expect(secondPath).toBe(firstPath);
    await expect(readFile(secondPath, "utf8")).resolves.toBe(`${secondContent}\n`);
  });

  it("发现损坏资源副本时从有效随包资源重建", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "zcode-remote-provider-config-"));
    tempDirs.push(runtimeRoot);
    const content = emptyRelease(1);
    const filePath = await materializeBundledZCodeBuiltinProviderConfig({
      environmentConfigRoot: runtimeRoot,
      content,
    });
    await writeFile(filePath, "corrupted", "utf8");

    await expect(
      materializeBundledZCodeBuiltinProviderConfig({ environmentConfigRoot: runtimeRoot, content }),
    ).resolves.toBe(filePath);
    await expect(readFile(filePath, "utf8")).resolves.toBe(`${content}\n`);
  });
});

function emptyRelease(revision: number): string {
  return JSON.stringify({
    schemaVersion: 1,
    revision,
    config: {
      providerConfigRules: { templateRules: [], providerRules: [] },
      modelConfigRules: {
        modelRules: [],
        modelApiRules: [],
        providerSiteRules: [],
        templateModelRules: [],
        builtinProviderModelRules: [],
      },
    },
  });
}
