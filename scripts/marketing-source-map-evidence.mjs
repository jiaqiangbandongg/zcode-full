import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TraceMap, eachMapping } from "@jridgewell/trace-mapping";

/** 只接受与该次构建完全匹配的 map；不会把当前 out 当作历史产物。 */
export async function loadGeneratedLineEvidence(outputRoot, domain, manifest) {
  if (
    manifest?.schemaVersion !== 1 ||
    manifest.status !== "fresh-stable" ||
    !Array.isArray(manifest.domains) ||
    !manifest.domains.includes(domain) ||
    !Array.isArray(manifest.changedFiles) ||
    manifest.changedFiles.length
  )
    return { status: "unverified" };
  const maps = Object.entries(manifest.outputs ?? {}).filter(
    ([key]) => key.startsWith(`${domain}/`) && key.endsWith(".map"),
  );
  if (!maps.length) return { status: "unverified" };
  const sources = new Map();
  for (const [key, hash] of maps) {
    if (key.split(/[\\/]/u).includes("..")) return { status: "unverified" };
    const path = resolve(outputRoot, key);
    let bytes;
    try {
      bytes = await readFile(path);
    } catch (error) {
      if (error.code === "ENOENT") return { status: "missing-map" };
      throw error;
    }
    if (createHash("sha256").update(bytes).digest("hex") !== hash) return { status: "mismatch" };
    const map = new TraceMap(JSON.parse(bytes.toString("utf8")), pathToFileURL(path).href);
    for (const source of map.resolvedSources) {
      if (source?.startsWith("file:")) {
        const file = fileURLToPath(source);
        if (!sources.has(file)) sources.set(file, new Set());
      }
    }
    eachMapping(map, (mapping) => {
      if (!mapping.source?.startsWith("file:") || mapping.originalLine === null) return;
      sources.get(fileURLToPath(mapping.source))?.add(mapping.originalLine);
    });
  }
  return {
    status: "matched",
    mapCount: maps.length,
    sources: Object.fromEntries(
      [...sources].map(([file, lines]) => [file, [...lines].sort((a, b) => a - b)]),
    ),
  };
}
