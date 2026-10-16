import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPlugin } from "../skills/plugin-creator/scripts/create-basic-plugin.mjs";
import { upsertDevMarketplace } from "../skills/plugin-creator/scripts/upsert-dev-marketplace.mjs";
import { atomicJson } from "../skills/plugin-creator/scripts/marketplace-files.mjs";

test("does not delete an existing temporary file when exclusive creation fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "creator-atomic-"));
  try {
    const path = join(root, "marketplace.json");
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, "existing writer");
    await assert.rejects(atomicJson(path, { name: "dev", plugins: [] }), /exist/i);
    assert.equal(await readFile(temporary, "utf8"), "existing writer");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dev listing is stable, localized, idempotent and preserves source and other entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "creator-dev-"));
  try {
    const plugin = await createPlugin({
      name: "demo",
      parentPath: join(root, "plugins"),
      components: ["skills"],
    });
    const source = await readFile(join(plugin, "skills/demo/SKILL.md"), "utf8");
    const first = await upsertDevMarketplace({
      pluginPath: plugin,
      displayName: "Demo",
      nameZh: "演示",
      descriptionZh: "演示工作流",
    });
    assert.match(first.marketplaceId, /^dev-creator-dev-.*-[a-f0-9]{8}$/);
    assert.equal(first.pluginId, `demo@${first.marketplaceId}`);
    assert.equal(first.marketplacePath, join(first.marketplaceRoot, "marketplace.json"));
    const market = JSON.parse(await readFile(first.marketplacePath, "utf8"));
    assert.equal(market.plugins[0].source, "./demo");
    assert.equal(market.plugins[0].displayName_i18n["zh-CN"], "演示");
    market.owner = { name: "Test" };
    market.plugins.unshift({ name: "other", source: "./other", custom: true });
    market.plugins[1].custom = 42;
    await writeFile(first.marketplacePath, JSON.stringify(market));
    const manifestPath = join(plugin, ".zcode-plugin/plugin.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.version = "0.1.1";
    await writeFile(manifestPath, JSON.stringify(manifest));
    const second = await upsertDevMarketplace({ pluginPath: plugin });
    assert.equal(second.marketplaceId, first.marketplaceId);
    const updated = JSON.parse(await readFile(first.marketplacePath, "utf8"));
    assert.deepEqual(
      updated.plugins.map((p) => p.name),
      ["other", "demo"],
    );
    assert.equal(updated.owner.name, "Test");
    assert.equal(updated.plugins[1].custom, 42);
    assert.equal(updated.plugins[1].version, "0.1.1");
    assert.equal(updated.plugins[1].displayName_i18n["zh-CN"], "演示");
    assert.equal(await readFile(join(plugin, "skills/demo/SKILL.md"), "utf8"), source);
    assert.equal((await upsertDevMarketplace({ pluginPath: plugin })).changed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("same-named workspaces get distinct dev markets", async () => {
  const root = await mkdtemp(join(tmpdir(), "creator-dev-identity-"));
  try {
    const markets = [];
    for (const name of ["one", "two"]) {
      const plugin = await createPlugin({
        name: "demo",
        parentPath: join(root, name, "project", "plugins"),
      });
      markets.push(await upsertDevMarketplace({ pluginPath: plugin }));
    }
    assert.notEqual(markets[0].marketplaceId, markets[1].marketplaceId);
    assert.match(markets[0].marketplaceId, /^dev-project-/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses implicit takeover, duplicate entries, source conflicts, escaping and locked markets", async () => {
  const root = await mkdtemp(join(tmpdir(), "creator-dev-conflict-"));
  try {
    const plugin = await createPlugin({ name: "demo", parentPath: join(root, "plugins") });
    const marketplacePath = join(root, "plugins", "marketplace.json");
    await writeFile(marketplacePath, JSON.stringify({ name: "production", plugins: [] }));
    await assert.rejects(upsertDevMarketplace({ pluginPath: plugin }), /explicit|development/i);
    const result = await upsertDevMarketplace({ pluginPath: plugin, marketplacePath });
    assert.equal(result.marketplaceId, "production");
    for (const plugins of [
      [{ name: "demo", source: "./other" }],
      [
        { name: "demo", source: "./demo" },
        { name: "demo", source: "./demo" },
      ],
    ]) {
      const content = JSON.stringify({ name: "production", plugins });
      await writeFile(marketplacePath, content);
      await assert.rejects(
        upsertDevMarketplace({ pluginPath: plugin, marketplacePath }),
        /source|duplicate/i,
      );
      assert.equal(await readFile(marketplacePath, "utf8"), content);
    }
    await assert.rejects(
      upsertDevMarketplace({
        pluginPath: plugin,
        marketplacePath: join(root, "elsewhere", "marketplace.json"),
      }),
      /outside/i,
    );
    await writeFile(marketplacePath, JSON.stringify({ name: "production", plugins: [] }));
    await writeFile(`${marketplacePath}.lock`, "busy");
    await assert.rejects(
      upsertDevMarketplace({ pluginPath: plugin, marketplacePath }),
      /busy|lock/i,
    );
    assert.equal(await readFile(`${marketplacePath}.lock`, "utf8"), "busy");
    if (process.platform !== "win32") {
      await mkdir(join(root, "linked-market"));
      await symlink(marketplacePath, join(root, "linked-market", "marketplace.json"));
      await assert.rejects(
        upsertDevMarketplace({
          pluginPath: plugin,
          marketplacePath: join(root, "linked-market", "marketplace.json"),
        }),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
