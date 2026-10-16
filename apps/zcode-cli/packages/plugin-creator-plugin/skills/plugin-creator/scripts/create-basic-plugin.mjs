import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { scaffoldFiles } from "./scaffold-files.mjs";

import {
  exists,
  rejectSymlink,
  atomicJson,
  marketplacePlan,
  withMarketplaceLock,
} from "./marketplace-files.mjs";

const COMPONENTS = ["skills", "commands", "mcp", "hooks", "scripts", "assets"];
export function normalizePluginName(input) {
  if (/[\\/]/u.test(input)) throw new Error("Plugin name must not contain path separators");
  const name = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
  if (!name || name.length > 64)
    throw new Error("Plugin name must contain 1–64 ASCII letters/digits/hyphens");
  return name;
}
async function checkDestination(root, path, force) {
  let current = path;
  while (current !== dirname(root)) {
    await rejectSymlink(current);
    if (current === root) break;
    current = dirname(current);
  }
  if (!force && (await exists(path))) throw new Error(`File already exists: ${path}`);
}
export async function createPlugin({
  name: rawName,
  parentPath = resolve("plugins"),
  marketplacePath,
  components = [],
  force = false,
}) {
  const name = normalizePluginName(rawName);
  if (components.some((component) => !COMPONENTS.includes(component)))
    throw new Error("Unsupported component");
  const root = resolve(parentPath, name);
  const marketPath = marketplacePath ? resolve(marketplacePath) : undefined;
  // 所有覆盖/路径检查先完成，避免在发现市场冲突前写出半份 scaffold。
  if (marketPath) await marketplacePlan(marketPath, root, name, force);
  await rejectSymlink(root);
  if (!force && (await exists(root))) throw new Error(`Plugin directory already exists: ${root}`);
  const files = scaffoldFiles(name, components);
  for (const file of files.keys()) await checkDestination(root, join(root, file), force);
  await mkdir(root, { recursive: true });
  for (const [file, contents] of files) {
    const destination = join(root, file);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, contents, { flag: force ? "w" : "wx" });
  }
  if (marketPath)
    await withMarketplaceLock(marketPath, async () =>
      atomicJson(marketPath, await marketplacePlan(marketPath, root, name, force)),
    );
  return root;
}
async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      path: { type: "string" },
      "marketplace-path": { type: "string" },
      force: { type: "boolean", default: false },
      ...Object.fromEntries(
        COMPONENTS.map((component) => [`with-${component}`, { type: "boolean", default: false }]),
      ),
    },
  });
  if (positionals.length !== 1)
    throw new Error(
      "Usage: node create-basic-plugin.mjs <name> [--path parent] [--with-skills] [--with-mcp] [--with-hooks] [--marketplace-path file] [--force]",
    );
  const root = await createPlugin({
    name: positionals[0],
    parentPath: values.path,
    marketplacePath: values["marketplace-path"],
    force: values.force,
    components: COMPONENTS.filter((component) => values[`with-${component}`]),
  });
  console.log(
    `Created ${root}. Customize the scaffold, then run zcode plugins validate before installation.`,
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
