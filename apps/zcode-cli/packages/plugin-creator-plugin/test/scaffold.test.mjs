import { mkdtemp, readFile, writeFile, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createPlugin } from "../skills/plugin-creator/scripts/create-basic-plugin.mjs";
import { preflightPlugin } from "../skills/plugin-creator/scripts/validate-plugin.mjs";

test("scaffold creates valid resources and preserves marketplace data on update", async () => {
  const root = await mkdtemp(join(tmpdir(), "plugin-creator-"));
  try {
    const marketplacePath = join(root, ".claude-plugin", "marketplace.json");
    await mkdir(join(root, ".claude-plugin"));
    await writeFile(
      marketplacePath,
      JSON.stringify({
        name: "personal",
        owner: { name: "User" },
        custom: 42,
        plugins: [{ name: "other", source: "./other" }],
      }),
    );
    const plugin = await createPlugin({
      name: "My Plugin",
      parentPath: join(root, "plugins"),
      marketplacePath,
      components: ["skills", "mcp", "hooks"],
    });
    const manifest = JSON.parse(
      await readFile(join(plugin, ".zcode-plugin", "plugin.json"), "utf8"),
    );
    assert.equal(manifest.name, "my-plugin");
    assert.deepEqual(await preflightPlugin(plugin), []);
    const market = JSON.parse(await readFile(marketplacePath, "utf8"));
    assert.equal(market.custom, 42);
    assert.deepEqual(
      market.plugins.map((p) => p.name),
      ["other", "my-plugin"],
    );
    assert.equal(market.plugins[1].source, "./plugins/my-plugin");
    assert.equal(market.plugins[1].policy, undefined);
    await assert.rejects(
      createPlugin({ name: "My Plugin", parentPath: join(root, "plugins"), marketplacePath }),
      /exist/i,
    );
    await createPlugin({
      name: "My Plugin",
      parentPath: join(root, "plugins"),
      marketplacePath,
      force: true,
    });
    const updated = JSON.parse(await readFile(marketplacePath, "utf8"));
    assert.deepEqual(
      updated.plugins.map((p) => p.name),
      ["other", "my-plugin"],
    );
    assert.equal(updated.owner.name, "User");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects invalid identifiers, escaping marketplace sources, placeholders and symlink outputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "creator-negative-"));
  try {
    for (const name of ["!!!", "../escape", "x".repeat(129)])
      await assert.rejects(createPlugin({ name, parentPath: root }));
    await assert.rejects(
      createPlugin({
        name: "demo",
        parentPath: join(root, "outside"),
        marketplacePath: join(root, "market", "marketplace.json"),
      }),
      /outside|escape/i,
    );
    const plugin = await createPlugin({ name: "valid", parentPath: root });
    const manifestPath = join(plugin, ".zcode-plugin", "plugin.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.description = "[TODO: description]";
    manifest.skills = "../outside";
    await writeFile(manifestPath, JSON.stringify(manifest));
    const errors = await preflightPlugin(plugin);
    assert(errors.some((e) => e.includes("TODO")));
    assert(errors.some((e) => /outside|escape/.test(e)));
    if (process.platform !== "win32") {
      await mkdir(join(root, "actual"));
      await symlink(join(root, "actual"), join(root, "linked"));
      await assert.rejects(
        createPlugin({ name: "linked", parentPath: root, force: true }),
        /symbolic/i,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generated MCP scaffold completes initialization and exposes its empty tool list", async () => {
  const { spawn } = await import("node:child_process");
  const root = await mkdtemp(join(tmpdir(), "creator-mcp-"));
  try {
    const plugin = await createPlugin({
      name: "mcp-smoke",
      parentPath: root,
      components: ["mcp", "hooks"],
    });
    const child = spawn(process.execPath, [join(plugin, "scripts", "mcp-server.mjs")], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    const done = new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    child.stdin.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26" },
      }) +
        "\n" +
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) +
        "\n",
    );
    assert.equal(await done, 0);
    const responses = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(responses[0].result.serverInfo.name, "mcp-smoke");
    assert.deepEqual(responses[1].result.tools, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects placeholders in skill content, duplicate market entries and symlinked parent escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "creator-integrity-"));
  try {
    const plugin = await createPlugin({
      name: "content",
      parentPath: root,
      components: ["skills"],
    });
    await writeFile(
      join(plugin, "skills", "content", "SKILL.md"),
      "---\nname: content\ndescription: TODO\n---\nTODO: implement this skill\n",
    );
    assert.ok((await preflightPlugin(plugin)).some((error) => /placeholder/i.test(error)));
    const marketplacePath = join(root, "marketplace.json");
    await writeFile(
      marketplacePath,
      JSON.stringify({
        name: "personal",
        plugins: [
          { name: "dup", source: "./first" },
          { name: "dup", source: "./second" },
        ],
      }),
    );
    await assert.rejects(
      createPlugin({ name: "dup", parentPath: root, marketplacePath, force: true }),
      /duplicate/i,
    );
    if (process.platform !== "win32") {
      await mkdir(join(root, "market"));
      await symlink(root, join(root, "market", "plugins"));
      await assert.rejects(
        createPlugin({
          name: "escape",
          parentPath: join(root, "market", "plugins"),
          marketplacePath: join(root, "market", "marketplace.json"),
        }),
        /symbolic/i,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
