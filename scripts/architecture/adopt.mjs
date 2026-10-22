/**
 * architecture:adopt —— 把一个目录登记为 managed 模块。
 *
 * 设计目的：unmanaged-new-file 规则要求新代码必须落在 managed 模块内，那么"登记一个模块"
 * 必须比"绕过规则"更便宜。本命令一次完成：
 *   1. 从实际 import 反推 requires（可与 --requires 合并）
 *   2. 生成缺失的五件套骨架（module.ts / contract.ts / contract.example.ts / contract.test.ts / CONTRACT.md）
 *   3. 在 architecture-policy.yaml 登记（保留注释；已存在则置 managed: true，不重复添加）
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";

import {
  discoverFiles,
  importsOf,
  loadPolicy,
  moduleForFile,
  posix,
  resolveImport,
} from "./policy.mjs";
import { loadWorkspace } from "./resolver.mjs";

const ARTIFACTS = [
  "module.ts",
  "contract.ts",
  "contract.example.ts",
  "contract.test.ts",
  "CONTRACT.md",
];

function camel(id) {
  return id.replace(/[-_](\w)/g, (_, c) => c.toUpperCase());
}

function templates({ id, requires, layer }) {
  const name = camel(id);
  return {
    "module.ts": `/**
 * ${id} 模块清单（architecture-governance managed 模块）。
 * 层：${layer}。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const ${name}Module = {
  id: "${id}",
  requires: [${requires.map((item) => `"${item}"`).join(", ")}],
  provides: ["${id}"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
`,
    "contract.ts": `/**
 * ${id} 对外契约：调用方要想正确调用就必须知道的一切都写在这里；其余对外不可见。
 * 每个方法注释写清：前置/后置条件、幂等性、发出哪些事件、是否等待持久化。
 */
export type ${name[0].toUpperCase() + name.slice(1)}Id = string & { readonly __brand: "${name[0].toUpperCase() + name.slice(1)}Id" };

export interface ${name[0].toUpperCase() + name.slice(1)}Contract {
  // TODO(${id}): 一个意图一个方法，不超过 8 个。
}
`,
    "contract.example.ts": `/**
 * ${id} 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type { ${name[0].toUpperCase() + name.slice(1)}Contract } from "./contract.js";

export function example${name[0].toUpperCase() + name.slice(1)}(_contract: ${name[0].toUpperCase() + name.slice(1)}Contract): void {
  // TODO(${id}): 展示最常见的一次完整调用。
}
`,
    "contract.test.ts": `import { describe, expect, it } from "vitest";

import { ${name}Module } from "./module.js";

// 契约测试只 import contract 与 module，不知道实现是谁；同一份测试应同时跑真实现与跨进程代理。
describe("${id} contract", () => {
  it("declares its module manifest", () => {
    expect(${name}Module.id).toBe("${id}");
  });
});
`,
    "CONTRACT.md": `# ${id}

一页以内。只写类型与测试表达不了的三样：模块存在的意图、不变量、与其它模块的交集在哪个 hook 点处理。

不变量：

- TODO
`,
  };
}

export async function adoptModule({
  cwd = process.cwd(),
  id,
  roots,
  layer = "adapters",
  owner = null,
  requires = [],
  publicEntrypoints = null,
}) {
  if (!id || !/^[a-z][a-z0-9-]*$/.test(id)) throw new Error(`模块 id 非法: ${id}`);
  if (!Array.isArray(roots) || roots.length === 0) throw new Error("必须提供至少一个 --root");
  const absoluteRoots = roots.map((root) => path.resolve(cwd, root));
  for (const root of absoluteRoots) {
    const stat = await fs.stat(root).catch(() => null);
    if (!stat?.isDirectory()) throw new Error(`root 不是目录: ${root}`);
  }

  const policyPath = path.join(cwd, "architecture-policy.yaml");
  const doc = parseDocument(await fs.readFile(policyPath, "utf8"));
  const modules = doc.get("modules");
  if (!modules || typeof modules.items === "undefined")
    throw new Error("architecture-policy.yaml 缺少 modules 序列");
  const existing = modules.items.find((item) => item.get?.("id") === id);
  const primaryRoot = posix(path.relative(cwd, absoluteRoots[0]));
  const entrypoints = publicEntrypoints ?? [
    `${primaryRoot}/index.ts`,
    `${primaryRoot}/contract.ts`,
  ];

  // 先用"假设已登记"的策略视图反推 requires，避免新模块的文件被算成它所在的 legacy 模块。
  const currentPolicy = await loadPolicy(cwd);
  const virtualModule = {
    id,
    roots: absoluteRoots,
    managed: true,
    requires: [],
    publicEntrypoints: entrypoints,
    layers: { [layer]: "." },
    layerOrder: [layer],
    owner,
  };
  const virtualPolicy = {
    ...currentPolicy,
    modules: [...currentPolicy.modules.filter((module) => module.id !== id), virtualModule],
  };
  const workspace = await loadWorkspace(cwd);
  const files = await discoverFiles(virtualPolicy);
  const knownFiles = new Set(files);
  const inferred = new Set(requires);
  for (const file of files) {
    if (moduleForFile(file, virtualPolicy)?.id !== id) continue;
    const source = await fs.readFile(file, "utf8");
    for (const specifier of importsOf(file, source)) {
      const target = resolveImport(file, specifier, knownFiles, workspace);
      const targetModule = target && moduleForFile(target, virtualPolicy);
      if (targetModule && targetModule.id !== id) inferred.add(targetModule.id);
    }
  }
  const finalRequires = [...inferred].sort();

  const created = [];
  const rendered = templates({ id, requires: finalRequires, layer });
  for (const artifact of ARTIFACTS) {
    const target = path.join(absoluteRoots[0], artifact);
    const exists = await fs.stat(target).catch(() => null);
    if (exists) continue;
    await fs.writeFile(target, rendered[artifact]);
    created.push(posix(path.relative(cwd, target)));
  }

  let registered = false;
  if (existing) {
    existing.set("managed", true);
    if (!existing.has("requires")) existing.set("requires", finalRequires);
    if (!existing.has("publicEntrypoints")) existing.set("publicEntrypoints", entrypoints);
    if (!existing.has("layers")) existing.set("layers", { [layer]: "." });
    if (owner && !existing.has("owner")) existing.set("owner", owner);
  } else {
    const node = doc.createNode({
      id,
      roots: absoluteRoots.map((root) => posix(path.relative(cwd, root))),
      managed: true,
      requires: finalRequires,
      publicEntrypoints: entrypoints,
      layers: { [layer]: "." },
      ...(owner ? { owner } : {}),
    });
    node.commentBefore = ` ${id}：由 architecture:adopt 登记`;
    modules.add(node);
    registered = true;
  }
  await fs.writeFile(policyPath, doc.toString({ lineWidth: 0 }));
  await loadPolicy(cwd);
  return {
    id,
    roots: absoluteRoots.map((root) => posix(path.relative(cwd, root))),
    requires: finalRequires,
    created,
    registered,
  };
}
