import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
export async function rejectSymlink(path) {
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error(`Refusing symbolic link: ${path}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
export async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  // 独占创建成功后才接管清理，避免失败时删除其他写入者的文件。
  const handle = await open(temporary, "wx");
  try {
    try {
      await handle.writeFile(JSON.stringify(value, null, 2) + "\n");
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
export async function marketplacePlan(path, pluginRoot, name, force, requireSameSource = false) {
  await rejectSymlink(dirname(path));
  await rejectSymlink(path);
  const root =
    basename(dirname(path)) === ".claude-plugin" ? dirname(dirname(path)) : dirname(path);
  const sourcePath = relative(root, pluginRoot);
  if (
    !sourcePath ||
    sourcePath === ".." ||
    sourcePath.startsWith(`..${sep}`) ||
    isAbsolute(sourcePath)
  )
    throw new Error("Plugin source is outside the marketplace root");
  // source 的词法路径合法仍可能经过符号链接逃出市场，生成前检查完整祖先链。
  let parent = pluginRoot;
  while (parent !== root) {
    await rejectSymlink(parent);
    parent = dirname(parent);
  }
  const value = (await exists(path))
    ? JSON.parse(await readFile(path, "utf8"))
    : { name: "personal", plugins: [] };
  if (
    !value ||
    typeof value !== "object" ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(value.name ?? "") ||
    !Array.isArray(value.plugins)
  )
    throw new Error("Invalid marketplace name or plugins array; validate the existing file first");
  const seen = new Set();
  for (const entry of value.plugins) {
    if (!entry || typeof entry.name !== "string") throw new Error("Invalid marketplace entry");
    if (seen.has(entry.name)) throw new Error(`Duplicate marketplace entry: ${entry.name}`);
    seen.add(entry.name);
  }
  const index = value.plugins.findIndex((entry) => entry.name === name);
  if (index !== -1 && !force) throw new Error(`Marketplace entry already exists: ${name}`);
  const previous = index === -1 ? {} : value.plugins[index];
  if (
    index !== -1 &&
    requireSameSource &&
    (typeof previous.source !== "string" || resolve(root, previous.source) !== pluginRoot)
  )
    throw new Error(`Marketplace source conflict: ${name}`);
  const entry = { ...previous, name, source: `./${sourcePath.split(sep).join("/")}` };
  if (index === -1) value.plugins.push(entry);
  else value.plugins[index] = entry;
  return value;
}
export async function withMarketplaceLock(path, operation) {
  await rejectSymlink(dirname(path));
  await rejectSymlink(path);
  await mkdir(dirname(path), { recursive: true });
  const lockPath = path + ".lock";
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error("Marketplace is busy: " + lockPath);
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid }));
    return await operation();
  } finally {
    await handle.close();
    await rm(lockPath, { force: true });
  }
}
