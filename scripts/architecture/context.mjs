import { promises as fs } from "node:fs";
import path from "node:path";

import { discoverFiles, loadPolicy, moduleForFile, posix } from "./policy.mjs";

export async function generateContext({ cwd = process.cwd(), moduleId }) {
  const policy = await loadPolicy(cwd);
  const module = policy.modules.find((item) => item.id === moduleId);
  if (!module) throw new Error(`未知模块: ${moduleId}`);
  const files = await discoverFiles(policy);
  const moduleFiles = files.filter((file) => moduleForFile(file, policy)?.id === moduleId);
  const manifest = moduleFiles.find((file) => path.basename(file) === "module.ts");
  const contracts = moduleFiles.filter((file) => path.basename(file).startsWith("contract."));
  // CONTRACT.md 不是源码扩展名，不在 discoverFiles 结果里，要按 root 直接探测。
  const contractDocs = (
    await Promise.all(
      module.roots.map((root) =>
        fs.stat(path.join(root, "CONTRACT.md")).then(
          () => path.join(root, "CONTRACT.md"),
          () => null,
        ),
      ),
    )
  ).filter(Boolean);
  const contractDoc = contractDocs[0];
  const dependencyContracts = module.requires.flatMap((dependencyId) => {
    const dependencyFiles = files.filter(
      (file) => moduleForFile(file, policy)?.id === dependencyId,
    );
    return dependencyFiles.filter((file) => path.basename(file) === "contract.ts");
  });
  const inline = async (file) => {
    const relative = posix(path.relative(cwd, file));
    const body = await fs.readFile(file, "utf8");
    const fence = file.endsWith(".md") ? "" : "```ts\n";
    return [`### ${relative}`, "", `${fence}${body.trimEnd()}\n${fence ? "```" : ""}`, ""];
  };
  const sections = [
    `# Architecture context: ${module.id}`,
    `owner: ${module.owner ?? "unassigned"}`,
    `managed: ${module.managed}`,
    `requires: ${module.requires.join(", ") || "none"}`,
    `layers: ${Object.keys(module.layers).length ? (module.layerOrder ?? Object.keys(module.layers)).join(" < ") : "none"}`,
    "",
    "## Files",
    ...(manifest ? [`- ${posix(path.relative(cwd, manifest))}`] : ["- module.ts: missing"]),
    ...contracts.map((file) => `- ${posix(path.relative(cwd, file))}`),
    ...module.publicEntrypoints.map((entry) => `- public: ${entry}`),
    "",
  ];
  // 阅读包内联契约正文：只列文件名会让 agent 再去打开实现；契约就是"读完就够"的那份。
  sections.push("## Contract");
  for (const file of [
    contractDoc,
    ...contracts.filter((f) => path.basename(f) === "contract.ts"),
  ].filter(Boolean)) {
    sections.push(...(await inline(file)));
  }
  sections.push("## Direct dependency contracts");
  if (dependencyContracts.length === 0) sections.push("- none discovered", "");
  for (const file of dependencyContracts) sections.push(...(await inline(file)));
  sections.push(
    "## Boundaries",
    "- Cross-module imports must use declared requirements and public entrypoints.",
    "- Add a contract example and contract test before exposing a new capability.",
    "- New source files must live inside a managed module (rule: unmanaged-new-file).",
  );
  return sections.join("\n");
}
