import { describe, expect, it } from "vitest";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  OFFICIAL_NODE_REPL_HOST_PLUGIN_NAME,
  OFFICIAL_PLUGIN_DEFINITIONS,
} from "../src/app/official-plugin-definitions.js";

// 不面向用户、不进市场的 seed 单元：只携带共用运行时产物，因此没有 listing。
// 白名单之外的条目一律必须带中文描述，漏配 listing 仍然会红。
const SEED_ONLY_PLUGIN_NAMES = new Set<string>([OFFICIAL_NODE_REPL_HOST_PLUGIN_NAME]);

describe("bundled Plugin Creator", () => {
  it("ships a default-enabled creator with every referenced resource and localized description", async () => {
    const definition = OFFICIAL_PLUGIN_DEFINITIONS.find((item) => item.name === "plugin-creator");
    expect(definition).toMatchObject({
      defaultEnabled: true,
      version: "0.1.1",
      listing: { displayName_i18n: { "zh-CN": "插件创建器" } },
    });
    const root = fileURLToPath(new URL("../../plugin-creator-plugin/", import.meta.url));
    const manifest = JSON.parse(await readFile(join(root, ".zcode-plugin/plugin.json"), "utf8"));
    expect(manifest.version).toBe(definition?.version);
    for (const path of definition?.requiredSeedPaths ?? []) await access(join(root, path));
    const skill = await readFile(join(root, "skills/plugin-creator/SKILL.md"), "utf8");
    expect(skill).toContain("name: plugin-creator");
    expect(skill).toContain("zcode plugins validate");
  });
  it("provides Chinese descriptions for all bundled entries", () => {
    for (const definition of OFFICIAL_PLUGIN_DEFINITIONS) {
      if (SEED_ONLY_PLUGIN_NAMES.has(definition.name)) {
        // 反向钉住 seed 单元的设计：它必须始终不进市场，一旦有人给它配了 listing
        // 就说明归属变了，应当先决定它是否面向用户，而不是让本用例静默放过。
        expect(definition.listing, definition.name).toBeUndefined();
        continue;
      }
      expect(definition.listing?.description_i18n?.["zh-CN"], definition.name).toBeTruthy();
    }
  });
});
