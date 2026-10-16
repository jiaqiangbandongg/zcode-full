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
// 每个用例独立临时 storageRoot 隔离。GitHub 用例先探测可达性，不可达则 skip 而非误判失败。
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { addZCodePluginMarketplace, getZCodePluginsOverview } from "../src/plugins.js";

const execFileAsync = promisify(execFile);

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

async function githubReachable(repoHttps: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["ls-remote", "--heads", repoHttps], { timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
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
      const manifestCopy = join(storageRoot, "marketplaces", "e2e-local-dir-market", "marketplace.json");
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
      await expect(addViaFacade("./definitely-not-a-real-marketplace-xyz", storageRoot, base)).rejects.toThrow();
      // 失败时不应写 known_marketplaces.json。
      expect(existsSync(join(storageRoot, "known_marketplaces.json"))).toBe(false);
    } finally {
      await rm(base, { force: true, recursive: true });
    }
  });

  it("GitHub 导入：raw git URL -> git 来源 -> 真实 clone -> 落盘", async () => {
    // 选体积小且仓库根带 .claude-plugin/marketplace.json 的公开仓库，避免大仓库 clone 超时。
    const repoUrl = "https://github.com/wshobson/agents.git";
    if (!(await githubReachable(repoUrl))) {
      console.warn("[e2e] GitHub 不可达，跳过 git URL clone 用例");
      return;
    }
    const base = await mkdtemp(join(tmpdir(), "zcode-e2e-github-"));
    const storageRoot = join(base, "storage");
    try {
      // https .git -> parseMarketplaceSourceInput 归类 source:"git" -> 真实 clone --depth 1。
      const summary = await addViaFacade(repoUrl, storageRoot, base);
      // manifest.name 即市场 id（该仓库 manifest 名为 claude-code-workflows）。
      expect(summary.id).toBe("claude-code-workflows");
      expect(summary.pluginCount).toBeGreaterThan(0);

      const known = JSON.parse(await readFile(join(storageRoot, "known_marketplaces.json"), "utf8")) as {
        marketplaces: Array<{ id: string; source: { source: string; url?: string } }>;
      };
      const rec = known.marketplaces.find((m) => m.id === summary.id);
      expect(rec?.source.source).toBe("git");
      expect(rec?.source.url).toBe(repoUrl);

      // clone 出的 manifest 复制进 storage。
      const manifestCopy = join(storageRoot, "marketplaces", summary.id, "marketplace.json");
      expect(existsSync(manifestCopy)).toBe(true);
    } finally {
      await rm(base, { force: true, recursive: true });
    }
  }, 120_000);

  it("GitHub 简写导入：raw owner/repo -> github 来源 -> 真实 clone -> 落盘", async () => {
    const repo = "wshobson/agents";
    if (!(await githubReachable(`https://github.com/${repo}.git`))) {
      console.warn("[e2e] GitHub 不可达，跳过 owner/repo 简写用例");
      return;
    }
    const base = await mkdtemp(join(tmpdir(), "zcode-e2e-gh-short-"));
    const storageRoot = join(base, "storage");
    try {
      // owner/repo 简写 -> parseMarketplaceSourceInput 归类 source:"github"。
      const summary = await addViaFacade(repo, storageRoot, base);
      expect(summary.id).toBe("claude-code-workflows");

      const known = JSON.parse(await readFile(join(storageRoot, "known_marketplaces.json"), "utf8")) as {
        marketplaces: Array<{ id: string; source: { source: string; repo?: string } }>;
      };
      const rec = known.marketplaces.find((m) => m.id === summary.id);
      expect(rec?.source.source).toBe("github");
      expect(rec?.source.repo).toBe(repo);
    } finally {
      await rm(base, { force: true, recursive: true });
    }
  }, 120_000);
});
