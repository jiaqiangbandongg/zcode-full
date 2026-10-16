#!/usr/bin/env node

import process from "node:process";
import path from "node:path";
import { Project } from "ts-morph";

const ROOT = process.cwd();

const EXCLUDE_GLOBS = [
  "!**/node_modules/**",
  "!**/dist/**",
  "!**/build/**",
  "!**/coverage/**",
  "!**/out/**",
];

const DEFAULT_GLOBS = [
  "packages/*/src/**/*.{ts,tsx,mts,cts}",
  "packages/*/test/**/*.{ts,tsx,mts,cts}",
  "apps/*/src/**/*.{ts,tsx,mts,cts}",
  "apps/*/test/**/*.{ts,tsx,mts,cts}",
  "harness/**/*.{ts,tsx,mts,cts}",
  ...EXCLUDE_GLOBS,
];

function loadProject(scope) {
  const project = new Project({
    tsConfigFilePath: path.join(ROOT, "tsconfig.base.json"),
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: false,
  });

  const globs = scope
    ? [
        `${scope.replace(/\/$/, "")}/**/*.{ts,tsx,mts,cts}`,
        ...EXCLUDE_GLOBS,
      ]
    : DEFAULT_GLOBS;

  const added = project.addSourceFilesAtPaths(globs);

  return { project, addedCount: added.length };
}

function resolveSourceFile(project, filePath) {
  const absolute = path.resolve(ROOT, filePath);
  const sourceFile = project.getSourceFile(absolute);
  if (!sourceFile) {
    throw new Error(`源文件未加载到 project: ${filePath}\n  - 确认路径是否正确\n  - 如使用了 --scope，检查文件是否在范围内`);
  }
  return sourceFile;
}

function kindLabel(declaration) {
  const kind = declaration.getKindName();
  switch (kind) {
    case "FunctionDeclaration": return "function";
    case "ClassDeclaration": return "class";
    case "InterfaceDeclaration": return "interface";
    case "TypeAliasDeclaration": return "type";
    case "EnumDeclaration": return "enum";
    case "VariableDeclaration": return "const";
    default: return kind.replace(/Declaration$/, "").toLowerCase();
  }
}

function listExports(project, filePath) {
  const sourceFile = resolveSourceFile(project, filePath);
  const map = sourceFile.getExportedDeclarations();
  const rows = [];

  for (const [name, declarations] of map) {
    for (const decl of declarations) {
      rows.push({
        name,
        kind: kindLabel(decl),
        line: decl.getStartLineNumber(),
      });
    }
  }

  rows.sort((a, b) => a.line - b.line);
  return { file: filePath, exports: rows };
}

function printListExports(result) {
  console.log(result.file);
  console.log("");
  console.log(`Exports (${result.exports.length}):`);
  if (result.exports.length === 0) {
    console.log("  (none)");
    return;
  }
  const nameWidth = Math.max(...result.exports.map((r) => r.name.length));
  const kindWidth = Math.max(...result.exports.map((r) => r.kind.length));
  for (const row of result.exports) {
    console.log(
      `  ${row.name.padEnd(nameWidth)}  ${row.kind.padEnd(kindWidth)}  line ${row.line}`,
    );
  }
}

function parseTarget(target) {
  const idx = target.lastIndexOf(":");
  const filePath = target.slice(0, idx);
  const exportName = target.slice(idx + 1);
  if (!filePath || !exportName) {
    throw new Error(`目标格式错误: ${target}（需 <file>:<exportName>）`);
  }
  return { filePath, exportName };
}

function toRelative(absolutePath) {
  return path.relative(ROOT, absolutePath);
}

function snippetForNode(node) {
  const text = node.getSourceFile().getFullText();
  const start = node.getStart();
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  let lineEnd = text.indexOf("\n", start);
  if (lineEnd === -1) lineEnd = text.length;
  return text.slice(lineStart, lineEnd).trim();
}

function isReExportReference(node) {
  let current = node.getParent();
  while (current) {
    const kind = current.getKindName();
    if (kind === "ExportSpecifier" || kind === "ExportDeclaration") {
      return true;
    }
    if (kind === "SourceFile") return false;
    current = current.getParent();
  }
  return false;
}

function findReferencesForExport(project, filePath, exportName) {
  const sourceFile = resolveSourceFile(project, filePath);
  const declarationsMap = sourceFile.getExportedDeclarations();
  const declarations = declarationsMap.get(exportName);
  if (!declarations || declarations.length === 0) {
    const available = [...declarationsMap.keys()].slice(0, 20).join(", ");
    throw new Error(
      `${filePath} 没有名为 "${exportName}" 的 export\n  可用 export（前 20 个）: ${available || "(无)"}`,
    );
  }

  const symbol = {
    name: exportName,
    kind: kindLabel(declarations[0]),
    file: filePath,
    line: declarations[0].getStartLineNumber(),
  };

  const declLocations = new Set(
    declarations.map((d) => `${d.getSourceFile().getFilePath()}:${d.getStartLineNumber()}`),
  );

  const refs = [];
  const reExportsTmp = [];
  for (const decl of declarations) {
    const nameNode = typeof decl.getNameNode === "function" ? decl.getNameNode() : null;
    const target = nameNode ?? decl;
    const refSymbols = target.findReferences();
    for (const refSymbol of refSymbols) {
      for (const ref of refSymbol.getReferences()) {
        const node = ref.getNode();
        const refSourceFile = node.getSourceFile();
        const line = node.getStartLineNumber();
        const { column } = refSourceFile.getLineAndColumnAtPos(node.getStart());
        const col = column;
        const filePathAbs = refSourceFile.getFilePath();
        const locationKey = `${filePathAbs}:${line}`;
        if (declLocations.has(locationKey)) continue;
        const entry = {
          file: toRelative(filePathAbs),
          line,
          col,
          snippet: snippetForNode(node),
        };
        if (isReExportReference(node)) {
          reExportsTmp.push(entry);
        } else {
          refs.push(entry);
        }
      }
    }
  }

  const seen = new Set();
  const unique = [];
  for (const ref of refs) {
    const key = `${ref.file}:${ref.line}:${ref.col}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(ref);
  }
  unique.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));

  const reExportSeen = new Set();
  const reExportsUnique = [];
  for (const ref of reExportsTmp) {
    const key = `${ref.file}:${ref.line}:${ref.col}`;
    if (reExportSeen.has(key)) continue;
    reExportSeen.add(key);
    reExportsUnique.push(ref);
  }
  reExportsUnique.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));

  return {
    symbol,
    references: unique,
    reExports: reExportsUnique,
    notes: ["Static analysis only. Dynamic import() and string-based usage not detected."],
  };
}

function truncateSnippet(s, max = 120) {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function printRefs(result) {
  const { symbol, references, reExports } = result;
  console.log(`${symbol.name}  (${symbol.kind}, exported at ${symbol.file}:${symbol.line})`);
  console.log("");
  console.log(`References (${references.length}):`);
  if (references.length === 0 && reExports.length === 0) {
    console.log("  Safe to delete (no static references and no re-exports).");
  } else if (references.length === 0) {
    console.log("  (none — only re-exported)");
  } else {
    for (const ref of references) {
      console.log(`  ${ref.file}:${ref.line}:${ref.col}`);
      console.log(`    > ${truncateSnippet(ref.snippet)}`);
    }
  }
  if (reExports.length > 0) {
    console.log("");
    console.log(`Re-exports (${reExports.length}):`);
    for (const ref of reExports) {
      console.log(`  ${ref.file}:${ref.line}`);
      console.log(`    > ${truncateSnippet(ref.snippet)}`);
    }
  }
  console.log("");
  for (const note of result.notes) {
    console.log(`Note: ${note}`);
  }
}

function printHelp() {
  console.log(`查询 TypeScript export 的所有引用位置（symbol 级），用于大型重构时安全删代码。

用法:
  pnpm dep:refs <file>:<exportName>           查 export 的所有引用
  pnpm dep:refs --list-exports <file>         列出文件的所有 export
  pnpm dep:refs <file>:<exportName> --json    JSON 输出
  pnpm dep:refs --scope <glob> <file>:<sym>   缩小扫描范围加速

选项:
  --list-exports          切换到 list-exports 模式
  --json                  以 JSON 输出
  --scope <glob>          只加载匹配 glob 的源文件（默认加载所有 workspace 源码 + test）
  -h, --help              查看帮助

示例:
  pnpm dep:refs packages/services/src/bots/botsService.ts:createBotSession
  pnpm dep:refs --list-exports packages/services/src/bots/botsService.ts

推荐用法:
  1. 先跑 pnpm knip 拿到 unused exports 列表（瞬秒）
  2. 对存疑的 export 用 pnpm dep:refs file:name 看具体引用者
  3. 决定能删 / 要先改调用方

说明:
  - 仅静态分析，不检测 dynamic import() 和字符串路径引用
  - 首次启动约 10-30 秒（加载全 workspace）；用 --scope 可显著加速
  - JSON 管道用 pnpm -s dep:refs ... --json | jq .（pnpm 默认会在 stdout 多打 2 行 banner）
`);
}

function parseArgs(argv) {
  const options = {
    target: null,        // "file:name" for refs query, "file" for list-exports
    mode: "refs",        // "refs" | "list-exports"
    json: false,
    scope: null,         // glob string, null = default
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    }

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--list-exports") {
      options.mode = "list-exports";
      continue;
    }

    if (arg === "--scope") {
      options.scope = argv[i + 1];
      i += 1;
      if (!options.scope) {
        throw new Error("--scope 需要一个 glob 参数");
      }
      continue;
    }

    if (arg === "--") {
      continue;
    }

    if (options.target !== null) {
      throw new Error(`只能传一个目标参数，已收到 ${options.target}，又收到 ${arg}`);
    }
    options.target = arg;
  }

  if (options.target === null) {
    throw new Error("缺少目标参数。用法: pnpm dep:refs <file>:<exportName> 或 pnpm dep:refs --list-exports <file>");
  }

  if (options.mode === "refs" && !options.target.includes(":")) {
    throw new Error(`refs 模式需要 <file>:<exportName> 格式，收到: ${options.target}`);
  }

  return options;
}

function main(argv) {
  if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) {
    printHelp();
    process.exit(0);
  }

  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`错误: ${error.message}`);
    process.exit(1);
  }

  const { project, addedCount } = loadProject(options.scope);
  if (addedCount === 0) {
    console.error(`警告: scope 内未加载任何源文件 (scope: ${options.scope})`);
  }

  try {
    if (options.mode === "list-exports") {
      const result = listExports(project, options.target);
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        printListExports(result);
      }
      process.exit(0);
    }

    if (options.mode === "refs") {
      const { filePath, exportName } = parseTarget(options.target);
      const result = findReferencesForExport(project, filePath, exportName);
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        printRefs(result);
      }
      process.exit(0);
    }
  } catch (error) {
    console.error(`错误: ${error.message}`);
    process.exit(1);
  }
}

main(process.argv.slice(2));
