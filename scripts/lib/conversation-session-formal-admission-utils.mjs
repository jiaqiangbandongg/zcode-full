import { access, readFile } from "node:fs/promises";
import { relative } from "node:path";

export async function readJson(path) {
  try {
    return { value: JSON.parse(await readFile(path, "utf8")) };
  } catch (error) {
    return error?.code === "ENOENT" ? { missing: true } : { error };
  }
}

export async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function diagnostic({ code, message, specPath, subjectPath }) {
  return { code, message, specPath, subjectPath };
}

export function toRepoPath(root, path) {
  return relative(root, path).replaceAll("\\", "/");
}

export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
