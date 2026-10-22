// ============================================================
// Custom Command Contracts - user-defined slash prompt commands
// ============================================================

import type { HookPluginContext } from "../hooks/index.js";
import type { ExecutionContext, TraceContext } from "../tracing/tracer.js";

export type CustomCommandScope = "project" | "user" | "system" | "admin";

export type CustomCommandSource = "agents" | "zcode" | "plugin";

export type CustomCommandDiagnosticSeverity = "warning" | "error";

export type CustomCommandDiagnosticCode =
  | "custom_command_duplicate_name"
  | "custom_command_invalid_frontmatter"
  | "custom_command_invalid_name"
  | "custom_command_read_failed"
  | "custom_command_root_not_found"
  | "custom_command_scan_failed"
  | "custom_command_too_large"
  | "custom_command_unknown_frontmatter"
  | "custom_command_unsupported_dynamic_syntax";

export interface CustomCommandRoot {
  /** 附加目录能力的目录限定名；不是项目身份。 */
  namespace?: string;
  path: string;
  plugin?: HookPluginContext;
  scope: CustomCommandScope;
  source: CustomCommandSource;
  priority: number;
}

export interface CustomCommandMetadata {
  allowedTools: string[];
  argumentHint?: string;
  description: string;
  disableNonInteractive: boolean;
  frontmatterKeys: string[];
  model?: string;
  name: string;
  path: string;
  plugin?: HookPluginContext;
  rootPath: string;
  scope: CustomCommandScope;
  skills: string[];
  source: CustomCommandSource;
}

export interface CustomCommandDiagnostic {
  code: CustomCommandDiagnosticCode;
  severity: CustomCommandDiagnosticSeverity;
  message: string;
  path?: string;
  commandName?: string;
}

export interface CustomCommandLoadOutcome {
  commands: CustomCommandMetadata[];
  diagnostics: CustomCommandDiagnostic[];
  totalDiscovered: number;
}

export interface CustomCommandContent {
  metadata: CustomCommandMetadata;
  content: string;
  bytesRead: number;
  sizeBytes: number;
  truncated: boolean;
}

export interface CustomCommandDiscoverRequest {
  roots?: CustomCommandRoot[];
  trace?: TraceContext;
  workingDirectory: string;
}

export interface CustomCommandLoadRequest {
  maxBytes?: number;
  name: string;
  roots?: CustomCommandRoot[];
  trace?: TraceContext;
  workingDirectory: string;
}

export interface CustomCommandOperationOptions {
  context?: ExecutionContext;
  signal?: AbortSignal;
}

export interface CustomCommandPort {
  discoverCommands(
    request: CustomCommandDiscoverRequest,
    options?: CustomCommandOperationOptions,
  ): Promise<CustomCommandLoadOutcome>;
  loadCommand(
    request: CustomCommandLoadRequest,
    options?: CustomCommandOperationOptions,
  ): Promise<CustomCommandContent>;
}

export interface CustomCommandExpansion {
  argumentCount: number;
  prompt: string;
  usedArgumentsPlaceholder: boolean;
}

export interface CustomCommandTemplateExpansion {
  argumentCount: number;
  body: string;
  usedArgumentsPlaceholder: boolean;
}

const POSITIONAL_ARGUMENT_PATTERN = /\$(\d+)/g;
const ALL_ARGUMENTS_TOKEN = "$ARGUMENTS";
const INLINE_SHELL_PATTERN = /!`[^`]*`/;
const FENCED_SHELL_PATTERN = /```!\s*[\s\S]*?```/;

export function expandCustomCommandPrompt(input: {
  args: string;
  command: CustomCommandContent;
}): CustomCommandExpansion {
  const expanded = expandCustomCommandTemplate(input);
  const dynamicSyntax = detectUnsupportedDynamicSyntax(expanded.body);
  if (dynamicSyntax) {
    throw new Error(
      `Custom command /${input.command.metadata.name} uses unsupported ${dynamicSyntax} expansion. Dynamic expansion is not available yet.`,
    );
  }

  return formatCustomCommandPrompt({
    body: expanded.body,
    command: input.command,
    argumentCount: expanded.argumentCount,
    usedArgumentsPlaceholder: expanded.usedArgumentsPlaceholder,
  });
}

export function expandCustomCommandTemplate(input: {
  args: string;
  command: CustomCommandContent;
}): CustomCommandTemplateExpansion {
  const args = input.args.trim();
  const positional = splitCustomCommandArguments(args);
  let usedArgumentsPlaceholder = input.command.content.includes(ALL_ARGUMENTS_TOKEN);
  let body = input.command.content.replaceAll(ALL_ARGUMENTS_TOKEN, args);
  body = body.replace(POSITIONAL_ARGUMENT_PATTERN, (_match, index: string) => {
    usedArgumentsPlaceholder = true;
    const offset = Number(index) - 1;
    return positional[offset] ?? "";
  });

  if (args.length > 0 && !usedArgumentsPlaceholder) {
    body = `${body.trimEnd()}\n\nUser arguments:\n${args}`;
  }

  return {
    argumentCount: positional.length,
    body,
    usedArgumentsPlaceholder,
  };
}

export function formatCustomCommandPrompt(input: {
  argumentCount: number;
  body: string;
  command: CustomCommandContent;
  usedArgumentsPlaceholder: boolean;
}): CustomCommandExpansion {
  return {
    argumentCount: input.argumentCount,
    prompt: [
      `Run custom command /${input.command.metadata.name}.`,
      `Command source: ${input.command.metadata.scope}/${input.command.metadata.source}.`,
      ...formatCommandSkillInstructions(input.command.metadata.skills ?? []),
      "",
      input.body.trim(),
    ].join("\n"),
    usedArgumentsPlaceholder: input.usedArgumentsPlaceholder,
  };
}

function formatCommandSkillInstructions(skills: string[]): string[] {
  if (skills.length === 0) return [];
  const names = skills.map((skill) => `\`${skill}\``).join(", ");
  return [
    `Required skills: ${names}.`,
    `Before following the command body, call the Skill tool for ${names}.`,
  ];
}

export function splitCustomCommandArguments(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaping) current += "\\";
  if (current.length > 0) args.push(current);
  return args;
}

export function detectUnsupportedDynamicSyntax(content: string): "shell" | undefined {
  if (INLINE_SHELL_PATTERN.test(content) || FENCED_SHELL_PATTERN.test(content)) {
    return "shell";
  }
  return undefined;
}
