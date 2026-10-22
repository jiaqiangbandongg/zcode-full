// E2E: 验证「自定义市场导入」最新 commit (feat: add custom marketplace source import popover)
// 触达的真实 agent 链路。
//
// UI 侧链路：AddMarketplacePopover -> PluginsSection.onAddMarketplace
//   -> pluginManagementStore.addMarketplace(source) -> agentService.addPluginMarketplace
//   -> 协议 plugins/marketplace/add -> server.ts dispatch -> 本文件验证的 facade。
//
// 本测试直接驱动 agent 侧 facade addZCodePluginMarketplace，喂入 popover 会原样下发的「自由文本字符串」，
// 覆盖 parseMarketplaceSourceInput -> loadMarketplaceFromSource(读 manifest / 真实 git clone) -> 落盘，
// 再用 getZCodePluginsOverview 复核（等价 popover 关闭后 UI refresh 能看到新市场）。
// 每个用例独立临时 storageRoot 隔离。真实外网导入用例见 marketplace-import-network.test.ts。
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addZCodePluginMarketplace, getZCodePluginsOverview } from "../src/plugins.js";
// popover 调用约定：source 为自由文本；pluginStorageRoot 真实运行时由 config 推导，
// 这里显式覆盖到临时目录做隔离，等价「换一个干净工作区做导入」。
function addViaFacade(source: string, storageRoot: string, workingDirectory: string) {
  return addZCodePluginMarketplace({
    source,
    pluginStorageRoot: storageRoot,
    workingDirectory,
    skipUserConfig: true,
  });
}

function overview(storageRoot: string, workingDirectory: string) {
  return getZCodePluginsOverview({
    pluginStorageRoot: storageRoot,
    workingDirectory,
    skipUserConfig: true,
  });
}

async function makeLocalMarketplace(root: string, name: string): Promise<void> {
  const pluginDir = join(root, "plugins", "hello");
  await mkdir(join(root, ".claude-plugin"), { recursive: true });
  await mkdir(join(pluginDir, ".claude-plugin"), { recursive: true });
  await mkdir(join(pluginDir, "skills", "hello"), { recursive: true });
  await writeFile(
    join(root, ".claude-plugin", "marketplace.json"),
    JSON.stringify(
      { name, plugins: [{ name: "hello", version: "1.0.0", source: "./plugins/hello" }] },
      null,
      2,
    ),
  );
  await writeFile(
    join(pluginDir, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "hello", version: "1.0.0", skills: "skills" }, null, 2),
  );
  await writeFile(join(pluginDir, "skills", "hello", "SKILL.md"), "# hello\n");
}

describe("marketplace 自定义导入 E2E (真实 agent facade)", () => {
  it("本地目录导入：raw 目录路径 -> directory 来源 -> 落盘 + overview 可见", async () => {
    const base = await mkdtemp(join(tmpdir(), "zcode-e2e-localdir-"));
    const storageRoot = join(base, "storage");
    const market = join(base, "my-local-market");
    try {
      await makeLocalMarketplace(market, "e2e-local-dir-market");

      // popover 直接把目录路径作为 source 传入（未结构化）。
      const summary = await addViaFacade(market, storageRoot, base);
      expect(summary.id).toBe("e2e-local-dir-market");
      expect(summary.pluginCount).toBe(1);

      const knownPath = join(storageRoot, "known_marketplaces.json");
      expect(existsSync(knownPath)).toBe(true);
      const known = JSON.parse(await readFile(knownPath, "utf8")) as {
        marketplaces: Array<{ id: string; source: { source: string; path?: string } }>;
      };
      const rec = known.marketplaces.find((m) => m.id === "e2e-local-dir-market");
      expect(rec?.source.source).toBe("directory");
      expect(rec?.source.path).toBe(market);

      // manifest 复制进 storage，供后续 install 引用。
      const manifestCopy = join(
        storageRoot,
        "marketplaces",
        "e2e-local-dir-market",
        "marketplace.json",
      );
      expect(existsSync(manifestCopy)).toBe(true);

      // 复核：overview 列出新市场（popover 关闭后 UI refresh 能看到它）。
      const ov = overview(storageRoot, base);
      expect(ov.marketplaces.some((m) => m.id === "e2e-local-dir-market")).toBe(true);
    } finally {
      await rm(base, { force: true, recursive: true });
    }
  });

  it("非法来源：facade 抛错（驱动 store 失败分支 -> 返回 false -> popover 保留输入），且不误落盘", async () => {
    const base = await mkdtemp(join(tmpdir(), "zcode-e2e-invalid-"));
    const storageRoot = join(base, "storage");
    try {
      // popover 里随手敲的一个不存在的本地路径。
      await expect(
        addViaFacade("./definitely-not-a-real-marketplace-xyz", storageRoot, base),
      ).rejects.toThrow();
      // 失败时不应写 known_marketplaces.json。
      expect(existsSync(join(storageRoot, "known_marketplaces.json"))).toBe(false);
    } finally {
      await rm(base, { force: true, recursive: true });
    }
  });
});
