import {
  analyzeBashCommand,
  isBashCommandPermissionSafe,
  type BashCommandInvocation,
} from "./bash-command-parser.js";

const DEFAULT_HEAD_LINES = 10;
const DEFAULT_TAIL_LINES = 10;
const SED_RANGE_PRINT_RE = /^(\d+),(\d+)p$/;
const SED_SINGLE_PRINT_RE = /^(\d+)p$/;
const SIMPLE_IGNORED_COMMAND_RE = /^\s*(echo|printf|true|:)\b/;
const GREP_SHORT_FLAGS_RE = /^-[niwxEFGPHh]+$/;
const GREP_CONTEXT_SHORT_RE = /^-[ABC]\d+$/;
const GREP_CONTEXT_LONG_RE = /^--(?:after-context|before-context|context)=\d+$/;
const GREP_ALLOWED_LONG_FLAGS = new Set([
  "--line-number",
  "--ignore-case",
  "--word-regexp",
  "--line-regexp",
  "--extended-regexp",
  "--fixed-strings",
  "--basic-regexp",
  "--perl-regexp",
  "--with-filename",
  "--no-filename",
  "--color=never",
  "--color=auto",
]);

export interface BashReadFileSource {
  filePath: string;
  startLine?: number;
  endLine?: number;
  tailLines?: number;
  requiresExitZero?: boolean;
}

export interface SelectedReadContent {
  content: string;
  offset?: number;
  limit?: number;
}

export function collectBashReadFileSources(command: string): BashReadFileSource[] {
  if (/[|<>]/.test(command)) return [];
  const analysis = analyzeBashCommand(command);
  if (!isBashCommandPermissionSafe(analysis) || analysis.hasRedirects) return [];
  if (analysis.commands.length === 0) return [];

  const sources: BashReadFileSource[] = [];
  for (const commandPart of analysis.commands) {
    const source =
      parseSedPrintSource(commandPart) ??
      parseCatSource(commandPart) ??
      parseHeadSource(commandPart) ??
      parseTailSource(commandPart) ??
      (analysis.commands.length === 1 ? parseGrepSource(commandPart) : undefined);
    if (source) {
      sources.push(source);
      continue;
    }
    if (analysis.commands.length > 1 && SIMPLE_IGNORED_COMMAND_RE.test(commandPart.commandText)) {
      continue;
    }
    return [];
  }
  return sources;
}

export function selectReadContent(
  content: string,
  source: BashReadFileSource,
): SelectedReadContent | undefined {
  if (source.tailLines !== undefined) {
    const lines = content.split("\n");
    if (lines.length > 0 && lines.at(-1) === "") lines.pop();
    if (lines.length === 0) return undefined;
    const limit = Math.min(source.tailLines, lines.length);
    const offset = lines.length - limit + 1;
    return {
      content: lines.slice(offset - 1).join("\n"),
      offset,
      limit,
    };
  }

  if (source.startLine === undefined) {
    return { content };
  }

  const lines = content.split("\n");
  const start = Math.max(1, source.startLine);
  const end = Math.max(start, source.endLine ?? start);
  if (start > lines.length) return undefined;
  return {
    content: lines.slice(start - 1, end).join("\n"),
    offset: start,
    limit: end - start + 1,
  };
}

function parseCatSource(commandPart: BashCommandInvocation): BashReadFileSource | undefined {
  const argv = commandPart.argv;
  if (argv[0] !== "cat") return undefined;
  let filePath: string | undefined;
  for (const arg of argv.slice(1)) {
    if (arg.startsWith("-")) {
      if (arg !== "-n" && arg !== "--number") return undefined;
      continue;
    }
    if (filePath !== undefined) return undefined;
    filePath = arg;
  }
  if (!isConcreteFilePath(filePath)) return undefined;
  return { filePath };
}

function parseHeadSource(commandPart: BashCommandInvocation): BashReadFileSource | undefined {
  const parsed = parseHeadTailCount(commandPart.argv, DEFAULT_HEAD_LINES);
  if (!parsed || commandPart.argv[0] !== "head") return undefined;
  return {
    filePath: parsed.filePath,
    startLine: 1,
    endLine: parsed.count,
  };
}

function parseTailSource(commandPart: BashCommandInvocation): BashReadFileSource | undefined {
  const parsed = parseHeadTailCount(commandPart.argv, DEFAULT_TAIL_LINES);
  if (!parsed || commandPart.argv[0] !== "tail") return undefined;
  return {
    filePath: parsed.filePath,
    tailLines: parsed.count,
  };
}

function parseHeadTailCount(
  argv: readonly string[],
  defaultCount: number,
): { count: number; filePath: string } | undefined {
  let count: number | undefined;
  let filePath: string | undefined;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "-n" || arg === "--lines") {
      const value = argv[++index];
      if (!isPositiveIntegerString(value)) return undefined;
      count = Number(value);
      continue;
    }
    if (arg.startsWith("--lines=")) {
      const value = arg.slice("--lines=".length);
      if (!isPositiveIntegerString(value)) return undefined;
      count = Number(value);
      continue;
    }
    if (/^-n\d+$/.test(arg)) {
      count = Number(arg.slice(2));
      continue;
    }
    if (/^-\d+$/.test(arg)) {
      count = Number(arg.slice(1));
      continue;
    }
    if (arg.startsWith("-")) return undefined;
    if (filePath !== undefined) return undefined;
    filePath = arg;
  }
  if (!isConcreteFilePath(filePath)) return undefined;
  return {
    count: count ?? defaultCount,
    filePath,
  };
}

function parseSedPrintSource(commandPart: BashCommandInvocation): BashReadFileSource | undefined {
  const argv = commandPart.argv;
  if (argv[0] !== "sed") return undefined;
  let quiet = false;
  let expression: string | undefined;
  let filePath: string | undefined;

  for (const arg of argv.slice(1)) {
    if (arg.startsWith("-")) {
      if (arg.startsWith("--")) {
        if (arg === "--in-place" || arg.startsWith("--in-place=")) return undefined;
        if (arg === "--expression") return undefined;
        if (arg === "--quiet" || arg === "--silent") quiet = true;
      } else {
        if (arg.includes("i")) return undefined;
        if (arg === "-e") return undefined;
        if (arg.includes("n")) quiet = true;
      }
      continue;
    }
    if (expression === undefined) {
      expression = arg;
    } else if (filePath === undefined) {
      filePath = arg;
    } else {
      return undefined;
    }
  }

  if (!quiet || expression === undefined || !isConcreteFilePath(filePath)) return undefined;
  const rangeMatch = SED_RANGE_PRINT_RE.exec(expression);
  if (rangeMatch) {
    return {
      filePath,
      startLine: Number(rangeMatch[1]),
      endLine: Number(rangeMatch[2]),
    };
  }
  const singleMatch = SED_SINGLE_PRINT_RE.exec(expression);
  if (!singleMatch) return undefined;
  const line = Number(singleMatch[1]);
  return {
    filePath,
    startLine: line,
    endLine: line,
  };
}

function parseGrepSource(commandPart: BashCommandInvocation): BashReadFileSource | undefined {
  const argv = commandPart.argv;
  if (argv[0] !== "grep" && argv[0] !== "egrep" && argv[0] !== "fgrep") return undefined;
  let pattern: string | undefined;
  let filePath: string | undefined;

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg.startsWith("-") && arg !== "-") {
      if (arg === "-A" || arg === "-B" || arg === "-C") {
        const value = argv[++index];
        if (!isNonNegativeIntegerString(value)) return undefined;
        continue;
      }
      if (
        GREP_CONTEXT_SHORT_RE.test(arg) ||
        GREP_CONTEXT_LONG_RE.test(arg) ||
        GREP_SHORT_FLAGS_RE.test(arg) ||
        GREP_ALLOWED_LONG_FLAGS.has(arg)
      ) {
        continue;
      }
      return undefined;
    }
    if (pattern === undefined) {
      pattern = arg;
    } else if (filePath === undefined) {
      filePath = arg;
    } else {
      return undefined;
    }
  }

  if (pattern === undefined || !isConcreteFilePath(filePath)) return undefined;
  if (/[*?[{]/.test(filePath)) return undefined;
  return {
    filePath,
    requiresExitZero: true,
  };
}

function isConcreteFilePath(value: string | undefined): value is string {
  return value !== undefined && value.length > 0 && value !== "-";
}

function isPositiveIntegerString(value: string | undefined): value is string {
  return value !== undefined && /^\d+$/.test(value) && Number(value) > 0;
}

function isNonNegativeIntegerString(value: string | undefined): value is string {
  return value !== undefined && /^\d+$/.test(value);
}
