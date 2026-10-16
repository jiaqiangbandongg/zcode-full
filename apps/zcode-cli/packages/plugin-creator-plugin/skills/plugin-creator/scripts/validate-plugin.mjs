import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const ROOT_TOKEN = "${CLAUDE_PLUGIN_ROOT}/";
const PLACEHOLDER = /\bTODO\b|\bFIXME\b|<your[-_ ][^>]+>|YOUR_API_KEY/u;
function outside(root, path) {
  const value = relative(root, path);
  return value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value);
}
/** 附加完整性检查，不复制 ZCode 的 manifest schema。 */
export async function preflightPlugin(path) {
  const root = await realpath(path);
  const errors = [];
  const manifestPath = await realpath(join(root, ".zcode-plugin", "plugin.json"));
  if (outside(root, manifestPath)) return ["Manifest symlink escapes outside plugin"];
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const resources = [];
  function inspect(value) {
    if (typeof value === "string") {
      if (PLACEHOLDER.test(value)) errors.push("Unresolved TODO/placeholder");
      const offset = value.indexOf(ROOT_TOKEN);
      if (offset >= 0) resources.push(value.slice(offset + ROOT_TOKEN.length).split(/["'\s]/u)[0]);
    } else if (Array.isArray(value)) value.forEach(inspect);
    else if (value && typeof value === "object") Object.values(value).forEach(inspect);
  }
  inspect(manifest);
  for (const field of ["skills", "commands", "hooks", "mcpServers"]) {
    const value = manifest[field];
    for (const entry of Array.isArray(value) ? value : [value])
      if (typeof entry === "string") resources.push(entry);
  }
  const visited = new Set();
  const visitedActual = new Set();
  while (resources.length) {
    const resource = resources.shift();
    if (visited.has(resource)) continue;
    visited.add(resource);
    const candidate = resolve(root, resource);
    if (outside(root, candidate)) {
      errors.push(`Resource escapes outside plugin: ${resource}`);
      continue;
    }
    try {
      const actual = await realpath(candidate);
      if (outside(root, actual)) {
        errors.push(`Resource symlink escapes outside plugin: ${resource}`);
        continue;
      }
      if (visitedActual.has(actual)) continue;
      visitedActual.add(actual);
      const info = await stat(actual);
      if (info.isDirectory()) {
        for (const entry of await readdir(actual)) {
          if (entry !== "node_modules" && entry !== ".git") resources.push(join(resource, entry));
        }
      } else if (info.isFile() && /\.(?:json|md|mjs|cjs|js|ts|txt|yaml|yml|toml)$/u.test(actual)) {
        const text = await readFile(actual, "utf8");
        if (actual.endsWith(".json")) inspect(JSON.parse(text));
        else if (PLACEHOLDER.test(text)) errors.push(`Unresolved placeholder: ${resource}`);
      }
    } catch (error) {
      errors.push(`Resource unavailable: ${resource}: ${error.message}`);
    }
  }
  return errors;
}
export async function validatePlugin(path, cli = "zcode") {
  const errors = await preflightPlugin(path);
  if (errors.length) throw new Error(errors.join("\n"));
  const nodeEntry = /\.[cm]?js$/u.test(cli);
  if (process.platform === "win32" && /\.cmd$/iu.test(cli))
    throw new Error("Use --cli with zcode.exe or the CLI JavaScript entrypoint on Windows");
  const args = [...(nodeEntry ? [cli] : []), "plugins", "validate", resolve(path)];
  const code = await new Promise((accept, reject) => {
    const child = spawn(nodeEntry ? process.execPath : cli, args, {
      stdio: "inherit",
      shell: false,
    });
    child.once("error", reject);
    child.once("close", (exitCode) => accept(exitCode ?? 1));
  });
  if (code !== 0) throw new Error(`ZCode plugin validation failed (${code})`);
}
async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { cli: { type: "string" } },
  });
  if (positionals.length !== 1)
    throw new Error(
      "Usage: node validate-plugin.mjs <plugin-path> [--cli zcode-executable-or-js-entry]",
    );
  await validatePlugin(positionals[0], values.cli);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
