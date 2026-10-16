import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { windowsPathToGitBashPath } from "@zcode/contracts";
import type { ExecutionRequest, ExecutionShellDialect } from "@zcode/contracts";
import { buildEmbeddedSearchPreludeContent } from "./embedded-search-prelude.js";

export type StartupShellDialect = ExecutionShellDialect | "legacy-shell";

export interface BashInternalScriptMaterializeOptions {
  rootDir: string;
  sessionId: string;
  shellDialect?: StartupShellDialect;
}

export interface BashInternalScriptContent {
  id: string;
  content: string;
}

export interface MaterializedBashSourceScript {
  path: string;
  shellPath: string;
}

export interface BashSourceScript {
  path: string;
  shellPath: string;
  optional?: boolean;
}

export interface ApplyBashSourcesOptions {
  leadingSources?: BashSourceScript[];
  rootDir: string;
  sessionId: string;
  shellDialect: StartupShellDialect;
}

export function applyBashSourcesToExecutionRequest(
  request: ExecutionRequest,
  options: ApplyBashSourcesOptions,
): ExecutionRequest {
  if (
    request.command.mode !== "shell" ||
    request.command.shellProfile !== "posix-bash"
  ) {
    return request;
  }

  const embeddedPreludeContent = buildEmbeddedSearchPreludeContent(request.bashPrelude, {
    shellDialect: options.shellDialect,
  });
  const internalScript = embeddedPreludeContent
    ? {
        id: "embedded-search-startup",
        content: embeddedPreludeContent,
      }
    : undefined;
  const materialized = materializeBashInternalSourceScript(internalScript, {
    rootDir: options.rootDir,
    sessionId: options.sessionId,
    shellDialect: options.shellDialect,
  });
  const sources = [
    ...(options.leadingSources ?? []),
    ...(materialized ? [materialized] : []),
  ];
  const command = applyBashSourceScripts(request.command.command, sources);
  if (command === request.command.command) return request;

  return {
    ...request,
    command: {
      ...request.command,
      command,
    },
  };
}

export function materializeBashInternalSourceScript(
  script: BashInternalScriptContent | undefined,
  options: BashInternalScriptMaterializeOptions,
): MaterializedBashSourceScript | undefined {
  if (!script) return undefined;
  if (!supportsBashSourceScripts(options.shellDialect)) return undefined;
  if (script.content.length === 0) return undefined;

  const sessionDir = join(options.rootDir, "bash-startup", sanitizePathSegment(options.sessionId));
  mkdirSync(sessionDir, { recursive: true });

  const hash = hashContent(script.content);
  const fileName = `${sanitizePathSegment(script.id)}-${hash}.sh`;
  const path = join(sessionDir, fileName);

  if (!existsSync(path) || readFileSync(path, "utf8") !== script.content) {
    writeFileSync(path, script.content, { encoding: "utf8", mode: 0o600 });
    try {
      chmodSync(path, 0o600);
    } catch {
      // Windows 可能不保留 POSIX mode bit；文件仍位于 ZCode 自有 storage 下。
    }
  }

  return {
    path,
    shellPath: options.shellDialect === "git-bash" ? windowsPathToGitBashPath(path) : path,
  };
}

export function applyBashSourceScript(
  command: string,
  materialized: MaterializedBashSourceScript | undefined,
): string {
  return applyBashSourceScripts(command, materialized ? [materialized] : []);
}

export function applyBashSourceScripts(command: string, sources: BashSourceScript[]): string {
  const sourceLines = sources.map((source) => {
    const sourceCommand = `. ${quoteSourcePath(source)}`;
    return source.optional ? `${sourceCommand} 2>/dev/null || true` : sourceCommand;
  });
  return sourceLines.length === 0 ? command : [...sourceLines, command].join("\n");
}

function supportsBashSourceScripts(shellDialect: StartupShellDialect | undefined): boolean {
  return shellDialect === "posix" || shellDialect === "git-bash";
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "") || "unknown";
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function shellQuoteAlways(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function quoteSourcePath(materialized: BashSourceScript): string {
  return materialized.path === materialized.shellPath
    ? shellQuoteAlways(materialized.shellPath)
    : shellQuote(materialized.shellPath);
}
