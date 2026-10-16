#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import process from "node:process";

const repoRoot = resolve(import.meta.dirname, "..");

const keywordPattern = /\b(?:acp|Acp[A-Za-z0-9_]*|ACP|claude|codex|gemini|opencode)\b/u;
const textExtensions = new Set([
  ".cjs",
  ".css",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".mjs",
  ".ps1",
  ".sh",
  ".toml",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

const defaultRoots = [
  "packages",
  "apps/zcode-cli/packages",
  "scripts",
];

const alwaysIgnoredSegments = new Set([
  ".git",
  "node_modules",
  "out",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".vite",
  "bundled-agents",
  "bundled-resources",
  "mock-cdn",
  "locales",
  "assets",
  "material-icons",
  ".e2e-home",
]);

const categoryRules = [
  {
    category: "runtime-blocker",
    patterns: [
      /^packages\/shared\/src\/zcode-agent-runtime\.ts$/u,
      /^packages\/desktop\/scripts\/ensure-local-runtime-assets\.mjs$/u,
      /^packages\/desktop\/electron-builder\.config\.js$/u,
      /^packages\/desktop\/wdio\.conf\.ts$/u,
      /^packages\/server\/src\/remote\/zcodeAgentDeploy\.ts$/u,
      /^scripts\/(?:download-glm|prepare-prebuilds|sign-macos-runtime-binaries)\.(?:mjs|sh)$/u,
      /^packages\/services\/src\/providers\/(?:claude|codex|gemini)/u,
      /^packages\/services\/src\/model-provider\/modelProviderServiceApply\.ts$/u,
      /^packages\/services\/src\/model-selection\//u,
      /^packages\/services\/src\/runtime-tools\/providerRuntimeResolver\.ts$/u,
      /^packages\/services\/src\/process\/runtimeProcessLifecycle\.ts$/u,
      /^packages\/services\/src\/runtime-tools\/runtimeCommandEnv\.ts$/u,
    ],
  },
  {
    category: "protocol-bridge",
    patterns: [
      /^packages\/services\/src\/session\/legacyTaskService\.ts$/u,
      /^packages\/services\/src\/zcode-agent\/zcodeLegacyTaskCompatService\.ts$/u,
      /^packages\/services\/src\/bots\/botRemoteWorkspaceBridge\.ts$/u,
      /^packages\/services\/src\/bots\//u,
      /^packages\/client\/src\/remoteServiceAccess\.ts$/u,
      /^packages\/desktop\/src\/host\/index\.ts$/u,
      /^packages\/desktop\/src\/(?:host|main)\/(?:desktopHostProcess|desktopRemoteSessions|externalProcessMetrics|processMonitorWindow|taskRealtimeBus|remoteWorkspaceServiceCollection)\.ts$/u,
      /^packages\/server\/src\/remote\/(?:connect|remoteAssetCdn|remoteAssetInstaller)\.ts$/u,
      /^packages\/ui\/src\/hooks\/useLegacyTaskService\.ts$/u,
    ],
  },
  {
    category: "compat-type",
    patterns: [
      /^packages\/shared\/src\/acp-types\.ts$/u,
      /^packages\/shared\/src\/task-realtime\.ts$/u,
      /^packages\/shared\/src\/tool-plan-adapter\.ts$/u,
      /^packages\/shared\/src\/(?:assistant-message-parts|assistant-presentation|channels|errors|index|mcp|model-selection-key|model-selection-types|permission-request-preview|protocol|subagents-types|test-ids|web-remote-control|zcode-agent-model-state|zcode-agent-policy)\.ts$/u,
      /^packages\/services\/src\/session\//u,
      /^packages\/services\/src\/usage-stats\//u,
      /^packages\/services\/src\/git\/repo\/gitCheckpointRepo\.ts$/u,
      /^packages\/services\/src\/logger\/serviceLogger\.ts$/u,
      /^packages\/ui\/src\//u,
      /^packages\/web\/src\//u,
      /^packages\/ui\/src\/hooks\/useAcp/u,
      /^packages\/ui\/src\/lib\/zcodeSessionProjection\.ts$/u,
      /^packages\/ui\/src\/store\/zcodeSessionStore/u,
    ],
  },
  {
    category: "legacy-data-parser",
    patterns: [
      /^packages\/shared\/src\/remoteResourcePackages\.ts$/u,
      /^packages\/shared\/src\/validation/u,
      /^packages\/shared\/src\/bots\.ts$/u,
      /^packages\/server\/src\/remote\/remoteAssetCache\.ts$/u,
      /^packages\/services\/src\/paths/u,
    ],
  },
  {
    category: "product-decision",
    patterns: [
      /^packages\/services\/src\/(?:commands|memory|plugins|skills)\//u,
      /^packages\/desktop\/src\/main\/(?:exportLogs|mcpUserDirectory\/.+)\.ts$/u,
      /^packages\/services\/src\/(?:feedback|hooks|model-provider|output-style|providers|settings-sync|subagents|workflow)\//u,
      /^packages\/services\/src\/(?:index|node)\.ts$/u,
      /^packages\/ui\/src\/settings\/(?:commands|mcp|model-provider|Skills)/u,
      /^packages\/ui\/src\/lib\/skillSourceFilter\.ts$/u,
      /^apps\/zcode-cli\/packages\/(?:adapters|bootstrap|cli|contracts|core)\/src\//u,
      /^apps\/zcode-cli\/packages\/cli\/scripts\//u,
      /^packages\/shared\/src\/(?:command-types|model-provider-types|plugin-marketplaces|settings-sync|zcode-protocol\/index)\.ts$/u,
    ],
  },
];

function parseArgs(argv) {
  const options = {
    includeDocs: false,
    includeTests: false,
    json: false,
    roots: [...defaultRoots],
    maxUnclassified: null,
    maxRuntimeBlocker: null,
  };

  for (const arg of argv) {
    if (arg === "--") {
      continue;
    }
    if (arg === "--include-docs") {
      options.includeDocs = true;
      continue;
    }
    if (arg === "--include-tests") {
      options.includeTests = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg.startsWith("--root=")) {
      options.roots = arg.slice("--root=".length).split(",").filter(Boolean);
      continue;
    }
    if (arg.startsWith("--max-unclassified=")) {
      options.maxUnclassified = parseLimit(arg, "--max-unclassified=");
      continue;
    }
    if (arg.startsWith("--max-runtime-blocker=")) {
      options.maxRuntimeBlocker = parseLimit(arg, "--max-runtime-blocker=");
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

function parseLimit(arg, prefix) {
  const raw = arg.slice(prefix.length);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid numeric limit: ${arg}`);
  }
  return value;
}

function printHelp() {
  console.log(`Usage: node scripts/audit-zcode-agent-remnants.mjs [options]

Options:
  --json                         Print machine-readable JSON
  --include-docs                 Include docs and markdown files
  --include-tests                Include test files
  --root=a,b                     Override scanned roots
  --max-unclassified=N           Fail when unclassified production hits exceed N
  --max-runtime-blocker=N        Fail when runtime-blocker hits exceed N
`);
}

function toPosixPath(path) {
  return path.split(sep).join("/");
}

function isTestPath(relativePath) {
  return /(^|\/)(test|tests|__tests__)(\/|$)/u.test(relativePath) ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(relativePath);
}

function shouldSkipPath(relativePath, options) {
  if (relativePath === "scripts/audit-zcode-agent-remnants.mjs") {
    return true;
  }
  const segments = relativePath.split("/");
  if (segments.some((segment) => alwaysIgnoredSegments.has(segment))) {
    return true;
  }
  if (!options.includeDocs && (segments.includes("docs") || relativePath.endsWith(".md"))) {
    return true;
  }
  if (!options.includeTests && isTestPath(relativePath)) {
    return true;
  }
  return false;
}

function isTextFile(relativePath, options) {
  if (options.includeDocs && relativePath.endsWith(".md")) {
    return true;
  }
  const extensionMatch = /\.[^.]+$/u.exec(relativePath);
  return extensionMatch ? textExtensions.has(extensionMatch[0]) : false;
}

function* walk(root, options) {
  if (!existsSync(root)) {
    return;
  }

  const stat = statSync(root);
  const relativePath = toPosixPath(relative(repoRoot, root));
  if (relativePath && shouldSkipPath(relativePath, options)) {
    return;
  }

  if (stat.isDirectory()) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      yield* walk(resolve(root, entry.name), options);
    }
    return;
  }

  if (stat.isFile() && isTextFile(relativePath, options)) {
    yield {
      absolutePath: root,
      relativePath,
    };
  }
}

function classifyFile(relativePath) {
  for (const rule of categoryRules) {
    if (rule.patterns.some((pattern) => pattern.test(relativePath))) {
      return rule.category;
    }
  }
  return "unclassified";
}

function scanFile(file) {
  const content = readFileSync(file.absolutePath, "utf8");
  const matches = [];
  const lines = content.split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    const match = keywordPattern.exec(line);
    if (!match) {
      continue;
    }
    matches.push({
      line: index + 1,
      keyword: match[0],
      preview: line.trim().slice(0, 180),
    });
  }
  return matches;
}

function buildReport(options) {
  const hits = [];
  for (const root of options.roots) {
    const absoluteRoot = resolve(repoRoot, root);
    for (const file of walk(absoluteRoot, options)) {
      const matches = scanFile(file);
      if (matches.length === 0) {
        continue;
      }
      hits.push({
        path: file.relativePath,
        category: classifyFile(file.relativePath),
        matches,
      });
    }
  }

  const categories = new Map();
  for (const hit of hits) {
    const current = categories.get(hit.category) ?? { files: 0, matches: 0 };
    current.files += 1;
    current.matches += hit.matches.length;
    categories.set(hit.category, current);
  }

  return {
    roots: options.roots,
    includeDocs: options.includeDocs,
    includeTests: options.includeTests,
    totalFiles: hits.length,
    totalMatches: hits.reduce((sum, hit) => sum + hit.matches.length, 0),
    categories: Object.fromEntries([...categories.entries()].sort()),
    hits: hits.sort((left, right) =>
      left.category.localeCompare(right.category) || left.path.localeCompare(right.path),
    ),
  };
}

function assertLimits(report, options) {
  const failures = [];
  const unclassifiedFiles = report.categories.unclassified?.files ?? 0;
  const runtimeBlockerFiles = report.categories["runtime-blocker"]?.files ?? 0;

  if (options.maxUnclassified !== null && unclassifiedFiles > options.maxUnclassified) {
    failures.push(
      `unclassified files ${unclassifiedFiles} > ${options.maxUnclassified}`,
    );
  }
  if (options.maxRuntimeBlocker !== null && runtimeBlockerFiles > options.maxRuntimeBlocker) {
    failures.push(
      `runtime-blocker files ${runtimeBlockerFiles} > ${options.maxRuntimeBlocker}`,
    );
  }

  return failures;
}

function printTextReport(report, failures) {
  console.log("ZCode Agent remnant audit");
  console.log(`roots: ${report.roots.join(", ")}`);
  console.log(`files: ${report.totalFiles}, matches: ${report.totalMatches}`);
  console.log("");
  console.log("category summary:");
  for (const [category, counts] of Object.entries(report.categories)) {
    console.log(`  ${category.padEnd(18)} files=${counts.files} matches=${counts.matches}`);
  }

  if (report.hits.length > 0) {
    console.log("");
    console.log("top files:");
    for (const hit of report.hits.slice(0, 80)) {
      const firstMatch = hit.matches[0];
      console.log(
        `  [${hit.category}] ${hit.path}:${firstMatch.line} ${firstMatch.keyword} (${hit.matches.length})`,
      );
    }
  }

  if (failures.length > 0) {
    console.log("");
    console.error(`ratchet failed: ${failures.join("; ")}`);
  }
}

try {
  const options = parseArgs(process.argv.slice(2));
  const report = buildReport(options);
  const failures = assertLimits(report, options);
  if (options.json) {
    console.log(JSON.stringify({ ...report, failures }, null, 2));
  } else {
    printTextReport(report, failures);
  }
  if (failures.length > 0) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
