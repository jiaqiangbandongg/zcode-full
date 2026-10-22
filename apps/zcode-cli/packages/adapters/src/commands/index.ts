// ============================================================
// Node Custom Command Adapter
// ============================================================

import { open, readdir, readFile, stat } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import type {
  CustomCommandContent,
  CustomCommandDiagnostic,
  CustomCommandLoadOutcome,
  CustomCommandMetadata,
  CustomCommandOperationOptions,
  CustomCommandPort,
  CustomCommandRoot,
} from "@zcode/contracts";
import {
  resolveDefaultCustomCommandRoots,
  type CustomCommandRootResolutionOptions,
} from "./roots.js";

const COMMAND_EXTENSION = ".md";
const COMMAND_NAME_PATTERN = /^[a-z0-9][a-z0-9_:-]{0,63}$/;
const DEFAULT_MAX_COMMAND_BYTES = 100_000;
const MAX_DESCRIPTION_LENGTH = 1024;
const MAX_SCAN_DEPTH = 12;
const SAFE_FRONTMATTER_KEYS = new Set([
  "allowed-tools",
  "argument-hint",
  "description",
  "disable-noninteractive",
  "model",
  "skills",
]);

export interface NodeCustomCommandAdapterOptions extends CustomCommandRootResolutionOptions {
  // 被禁用的命令 .md 绝对路径集合（来自 config.json 的 command.<path>.enable=false）。
  // 命中的命令在发现阶段直接剔除，使 discover/load/inspect 全链路保持一致。
  disabledPaths?: Iterable<string>;
}

export class NodeCustomCommandAdapter implements CustomCommandPort {
  private readonly disabledPaths: ReadonlySet<string>;

  constructor(private readonly options: NodeCustomCommandAdapterOptions = {}) {
    this.disabledPaths = new Set(Array.from(options.disabledPaths ?? [], (path) => resolve(path)));
  }

  async discoverCommands(
    request: { roots?: CustomCommandRoot[]; workingDirectory: string },
    options?: CustomCommandOperationOptions,
  ): Promise<CustomCommandLoadOutcome> {
    throwIfAborted(options);

    const workingDirectory = resolve(request.workingDirectory);
    const roots =
      request.roots ?? (await resolveDefaultCustomCommandRoots(workingDirectory, this.options));
    const diagnostics: CustomCommandDiagnostic[] = [];
    const selected = new Map<string, CustomCommandMetadata>();
    let totalDiscovered = 0;

    for (const root of roots.toSorted((a, b) => a.priority - b.priority)) {
      throwIfAborted(options);
      const commandPaths = await this.commandFilesUnderRoot(root, diagnostics);
      for (const path of commandPaths) {
        throwIfAborted(options);
        const parsed = await this.parseCommand(path, root, diagnostics);
        if (!parsed) continue;
        // 命中 config 禁用名单的命令不进入可用集合
        if (this.disabledPaths.has(resolve(parsed.path))) continue;
        totalDiscovered++;
        if (selected.has(parsed.name)) {
          diagnostics.push({
            code: "custom_command_duplicate_name",
            commandName: parsed.name,
            message: `Duplicate custom command ignored: ${parsed.name}`,
            path,
            severity: "warning",
          });
          continue;
        }
        selected.set(parsed.name, parsed);
      }
    }

    return {
      commands: Array.from(selected.values()).toSorted((a, b) => a.name.localeCompare(b.name)),
      diagnostics,
      totalDiscovered,
    };
  }

  async loadCommand(
    request: {
      maxBytes?: number;
      name: string;
      roots?: CustomCommandRoot[];
      workingDirectory: string;
    },
    options?: CustomCommandOperationOptions,
  ): Promise<CustomCommandContent> {
    throwIfAborted(options);

    const outcome = await this.discoverCommands(
      {
        roots: request.roots,
        workingDirectory: request.workingDirectory,
      },
      options,
    );
    const normalizedName = normalizeCommandName(request.name);
    const metadata = outcome.commands.find((command) => command.name === normalizedName);
    if (!metadata) {
      throw new Error(`Custom command not found: ${request.name}`);
    }

    const maxBytes = request.maxBytes ?? DEFAULT_MAX_COMMAND_BYTES;
    const info = await stat(metadata.path);
    const truncated = info.size > maxBytes;
    const buffer = truncated
      ? await readFirstBytes(metadata.path, maxBytes)
      : await readFile(metadata.path);

    return {
      metadata,
      bytesRead: buffer.byteLength,
      content: stripFrontmatter(buffer.toString("utf8")).trim(),
      sizeBytes: info.size,
      truncated,
    };
  }

  private async commandFilesUnderRoot(
    root: CustomCommandRoot,
    diagnostics: CustomCommandDiagnostic[],
  ): Promise<string[]> {
    try {
      const info = await stat(root.path);
      if (!info.isDirectory()) return [];
      return await scanMarkdownFiles(root.path, diagnostics);
    } catch (error) {
      if (isNotFoundError(error)) return [];
      diagnostics.push({
        code: "custom_command_scan_failed",
        message:
          error instanceof Error ? error.message : `Failed to scan command root: ${root.path}`,
        path: root.path,
        severity: "warning",
      });
      return [];
    }
  }

  private async parseCommand(
    path: string,
    root: CustomCommandRoot,
    diagnostics: CustomCommandDiagnostic[],
  ): Promise<CustomCommandMetadata | null> {
    let rawContent: string;
    try {
      rawContent = await readFile(path, "utf8");
    } catch (error) {
      if (isNotFoundError(error)) return null;
      diagnostics.push({
        code: "custom_command_read_failed",
        message: error instanceof Error ? error.message : `Failed to read custom command: ${path}`,
        path,
        severity: "warning",
      });
      return null;
    }

    const name = commandNameFromPath(path, root.path);
    if (!COMMAND_NAME_PATTERN.test(name)) {
      diagnostics.push({
        code: "custom_command_invalid_name",
        commandName: name,
        message: `Invalid custom command name: ${name}`,
        path,
        severity: "error",
      });
      return null;
    }

    const frontmatter = extractFrontmatter(rawContent);
    const parsed = frontmatter ? parseFlatYaml(frontmatter, path, diagnostics) : emptyFrontmatter();
    const body = stripFrontmatter(rawContent).trim();
    const description = parseScalar(parsed.values.description) ?? extractDescription(body);
    if (!description) {
      diagnostics.push({
        code: "custom_command_invalid_frontmatter",
        commandName: name,
        message: `Custom command must include a description or non-empty body: ${path}`,
        path,
        severity: "error",
      });
      return null;
    }

    for (const key of parsed.keys) {
      if (SAFE_FRONTMATTER_KEYS.has(key)) continue;
      diagnostics.push({
        code: "custom_command_unknown_frontmatter",
        commandName: name,
        message: `Unknown custom command frontmatter key: ${key}`,
        path,
        severity: "warning",
      });
    }

    return {
      allowedTools: parseList(parsed.values["allowed-tools"]),
      argumentHint: parseScalar(parsed.values["argument-hint"]),
      description: truncate(description, MAX_DESCRIPTION_LENGTH),
      disableNonInteractive: parseBoolean(parsed.values["disable-noninteractive"]),
      frontmatterKeys: parsed.keys,
      model: parseScalar(parsed.values.model),
      name: root.namespace ? `${root.namespace.toLowerCase()}/${name}` : name,
      path,
      plugin: root.plugin,
      rootPath: root.path,
      scope: root.scope,
      skills: parseList(parsed.values.skills),
      source: root.source,
    };
  }
}

export function createNodeCustomCommandAdapter(
  options: NodeCustomCommandAdapterOptions = {},
): NodeCustomCommandAdapter {
  return new NodeCustomCommandAdapter(options);
}

async function scanMarkdownFiles(
  directory: string,
  diagnostics: CustomCommandDiagnostic[],
  depth = 0,
): Promise<string[]> {
  if (depth > MAX_SCAN_DEPTH) return [];
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const results: string[] = [];
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const target = await stat(path);
          isDirectory = target.isDirectory();
          isFile = target.isFile();
        } catch {
          // 悬空 symlink 或无权限：跳过该条目，继续扫描其余命令
          continue;
        }
      }
      if (isDirectory) {
        results.push(...(await scanMarkdownFiles(path, diagnostics, depth + 1)));
      } else if (isFile && entry.name.toLowerCase().endsWith(COMMAND_EXTENSION)) {
        results.push(path);
      }
    }
    return results;
  } catch (error) {
    diagnostics.push({
      code: "custom_command_scan_failed",
      message:
        error instanceof Error ? error.message : `Failed to scan command directory: ${directory}`,
      path: directory,
      severity: "warning",
    });
    return [];
  }
}

function commandNameFromPath(path: string, rootPath: string): string {
  const relativePath = relative(rootPath, path);
  const withoutExtension = relativePath.slice(0, -COMMAND_EXTENSION.length);
  return normalizeCommandName(withoutExtension.split(/[\\/]+/).join(":"));
}

function normalizeCommandName(name: string): string {
  return name.trim().replace(/^\/+/, "").toLowerCase();
}

function extractFrontmatter(content: string): string | null {
  const normalized = content.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---")) return null;
  const lines = normalized.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (endIndex <= 0) return null;
  return lines.slice(1, endIndex).join("\n");
}

function stripFrontmatter(content: string): string {
  const normalized = content.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---")) return content;
  const lines = normalized.split(/\r?\n/);
  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (endIndex <= 0) return content;
  return lines.slice(endIndex + 1).join("\n");
}

function emptyFrontmatter(): { keys: string[]; values: Record<string, string> } {
  return { keys: [], values: {} };
}

function parseFlatYaml(
  frontmatter: string,
  path: string,
  diagnostics: CustomCommandDiagnostic[],
): { keys: string[]; values: Record<string, string> } {
  const values: Record<string, string> = {};
  const keys: string[] = [];

  for (const [index, line] of frontmatter.split(/\r?\n/).entries()) {
    if (line.trim().length === 0 || line.trim().startsWith("#")) continue;
    if (/^\s/.test(line)) continue;

    const separator = line.indexOf(":");
    if (separator <= 0) {
      diagnostics.push({
        code: "custom_command_invalid_frontmatter",
        message: `Invalid frontmatter line ${index + 1} in ${basename(path)}`,
        path,
        severity: "warning",
      });
      continue;
    }

    const key = line.slice(0, separator).trim();
    keys.push(key);
    values[key] = line.slice(separator + 1).trim();
  }

  return { keys, values };
}

function parseScalar(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseBoolean(value: string | undefined): boolean {
  const scalar = parseScalar(value)?.toLowerCase();
  return scalar === "true" || scalar === "yes";
}

function parseList(value: string | undefined): string[] {
  const scalar = parseScalar(value);
  if (!scalar) return [];
  const withoutBrackets = scalar.replace(/^\[/, "").replace(/\]$/, "");
  return withoutBrackets
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function extractDescription(body: string): string | undefined {
  const line = body
    .split(/\r?\n/)
    .map((candidate) =>
      candidate
        .replace(/^#+\s*/, "")
        .replace(/^[-*]\s*/, "")
        .trim(),
    )
    .find(Boolean);
  return line ? truncate(line, MAX_DESCRIPTION_LENGTH) : undefined;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

async function readFirstBytes(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(Math.max(0, maxBytes));
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function throwIfAborted(options: CustomCommandOperationOptions | undefined): void {
  if (options?.signal?.aborted) {
    throw new Error("Custom command operation cancelled");
  }
}
