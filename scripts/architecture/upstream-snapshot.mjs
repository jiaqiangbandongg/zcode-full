import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gitFileNames } from "./git-file-names.mjs";

export function isSnapshotPath(value) {
  return (
    typeof value === "string" &&
    !value.includes("\\") &&
    value.split("/").every((part) => part && part !== "." && part !== "..") &&
    !value.includes(":")
  );
}

function isFileMap(files) {
  return (
    files &&
    typeof files === "object" &&
    !Array.isArray(files) &&
    Object.entries(files).every(
      ([file, blob]) =>
        isSnapshotPath(file) &&
        typeof blob === "string" &&
        /^(100644|100755|120000) [a-f0-9]{40}$/.test(blob),
    )
  );
}

/** 独立公开历史没有源仓库对象；固定内容与模式仍须同时匹配暂存区和工作区。 */
export async function readUpstreamSnapshot(cwd, snapshotPath) {
  if (!isSnapshotPath(snapshotPath)) throw new Error("acceptedUpstreamSnapshot 路径无效");
  const snapshot = JSON.parse(await readFile(resolve(cwd, snapshotPath), "utf8"));
  if (
    snapshot.version !== 1 ||
    !isFileMap(snapshot.files) ||
    !isFileMap(snapshot.historicalFiles ?? {}) ||
    !Array.isArray(snapshot.introduced) ||
    !snapshot.introduced.every(isSnapshotPath)
  ) {
    throw new Error("acceptedUpstreamSnapshot 清单无效");
  }
  const [index, dirty] = await Promise.all([
    gitFileNames(cwd, ["ls-files", "--stage", "-z"]),
    gitFileNames(cwd, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--name-only",
      "-z",
      "--",
    ]),
  ]);
  const different = new Set(dirty);
  const accepted = new Set();
  const historical = new Set();
  for (const entry of index) {
    const separator = entry.indexOf("\t");
    const file = entry.slice(separator + 1);
    const [mode, blob, stage] = entry.slice(0, separator).split(" ");
    if (stage === "0" && !different.has(file) && snapshot.files[file] === `${mode} ${blob}`)
      accepted.add(file);
    if (
      stage === "0" &&
      !different.has(file) &&
      snapshot.historicalFiles?.[file] === `${mode} ${blob}`
    )
      historical.add(file);
  }
  return { accepted, historical, introduced: snapshot.introduced };
}
