import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { normalizePluginName } from "./create-basic-plugin.mjs";
import {
  atomicJson,
  exists,
  marketplacePlan,
  rejectSymlink,
  withMarketplaceLock,
} from "./marketplace-files.mjs";
import { preflightPlugin } from "./validate-plugin.mjs";

function devMarketplaceName(root) {
  const directory = basename(root) === "plugins" ? basename(dirname(root)) : basename(root);
  const label =
    directory
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-|-$/gu, "")
      .slice(0, 48) || "workspace";
  const identity = process.platform === "win32" ? root.toLowerCase() : root;
  return `dev-${label}-${createHash("sha256").update(identity).digest("hex").slice(0, 8)}`;
}

/** 只更新开发目录；安装状态始终由现有 CLI 管理，不能重写用户源码或内部缓存。 */
export async function upsertDevMarketplace({
  pluginPath,
  marketplacePath,
  displayName,
  nameZh,
  descriptionZh,
}) {
  await rejectSymlink(resolve(pluginPath));
  const pluginRoot = await realpath(pluginPath);
  const errors = await preflightPlugin(pluginRoot);
  if (errors.length) throw new Error(errors.join("\n"));
  const manifest = JSON.parse(
    await readFile(join(pluginRoot, ".zcode-plugin", "plugin.json"), "utf8"),
  );
  const name = normalizePluginName(manifest.name);
  if (name !== manifest.name || name !== basename(pluginRoot))
    throw new Error("Plugin directory and manifest name must match");
  if (typeof manifest.version !== "string" || !manifest.version.trim())
    throw new Error("A plugin version is required for dev updates");
  const requestedPath = marketplacePath
    ? resolve(marketplacePath)
    : join(dirname(pluginRoot), "marketplace.json");
  const root =
    basename(dirname(requestedPath)) === ".claude-plugin"
      ? dirname(dirname(requestedPath))
      : dirname(requestedPath);
  await rejectSymlink(root);
  await rejectSymlink(dirname(requestedPath));
  await rejectSymlink(requestedPath);
  if (!(await exists(root)))
    throw new Error("Marketplace root is missing or outside the plugin parent");
  // macOS /var 与 /private/var 等系统路径别名须统一后比较，否则合法来源会误判越界。
  const canonicalRoot = await realpath(root);
  const path = join(canonicalRoot, relative(root, requestedPath));
  // 先检查路径，避免给越界/符号链接目标创建锁文件或父目录。
  await marketplacePlan(path, pluginRoot, name, true, true);
  const defaultName = devMarketplaceName(canonicalRoot);
  return withMarketplaceLock(path, async () => {
    const previous = (await exists(path)) ? JSON.parse(await readFile(path, "utf8")) : undefined;
    if (!marketplacePath && previous && previous.name !== defaultName)
      throw new Error(
        "Existing marketplace is not this development market; pass --marketplace-path explicitly to reuse it",
      );
    const market = await marketplacePlan(path, pluginRoot, name, true, true);
    if (!previous) market.name = defaultName;
    const entry = market.plugins.find((item) => item.name === name);
    Object.assign(entry, { version: manifest.version, description: manifest.description ?? "" });
    entry.displayName = displayName ?? entry.displayName ?? name;
    if (nameZh) entry.displayName_i18n = { ...entry.displayName_i18n, "zh-CN": nameZh };
    if (descriptionZh)
      entry.description_i18n = { ...entry.description_i18n, "zh-CN": descriptionZh };
    const changed = JSON.stringify(previous) !== JSON.stringify(market);
    if (changed) await atomicJson(path, market);
    return {
      marketplaceId: market.name,
      marketplaceRoot: canonicalRoot,
      marketplacePath: path,
      pluginId: `${name}@${market.name}`,
      pluginPath: pluginRoot,
      version: manifest.version,
      changed,
    };
  });
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "marketplace-path": { type: "string" },
      "display-name": { type: "string" },
      "name-zh": { type: "string" },
      "description-zh": { type: "string" },
    },
  });
  if (positionals.length !== 1)
    throw new Error(
      "Usage: node upsert-dev-marketplace.mjs <plugin-path> [--marketplace-path file] [--display-name name] [--name-zh name] [--description-zh text]",
    );
  const result = await upsertDevMarketplace({
    pluginPath: positionals[0],
    marketplacePath: values["marketplace-path"],
    displayName: values["display-name"],
    nameZh: values["name-zh"],
    descriptionZh: values["description-zh"],
  });
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
