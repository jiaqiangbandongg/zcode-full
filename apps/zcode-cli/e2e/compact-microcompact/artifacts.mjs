import { writeFile } from "node:fs/promises";

export async function writeJsonFile(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}
