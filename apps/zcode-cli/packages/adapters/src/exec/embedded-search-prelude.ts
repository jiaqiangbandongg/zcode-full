import {
  type EmbeddedSearchBackend,
  type ExecutionEmbeddedSearchPrelude,
  type ExecutionShellSelection,
  windowsPathToGitBashPath,
} from "@zcode/contracts";

type EmbeddedSearchPreludeShellDialect = ExecutionShellSelection["dialect"];
type EmbeddedSearchCommandBackend = Exclude<EmbeddedSearchBackend, { kind: "native-binaries" }>;

interface EmbeddedSearchPreludeOptions {
  shellDialect?: EmbeddedSearchPreludeShellDialect;
}

// ugrep 的 -z/-Z 与 GNU grep 的 null-data 语义不同；这些参数必须绕回系统 grep。
const GREP_BYPASS_CASE_PATTERN =
  "-*-filter*|-*-pager*|-*-view*|-*-format-open*|-*-config*|---*|-@*|-*-save-config*|-[Zz]*|-[!-]*[Zz]*|--null|--null-data";

const BFS_DEFAULT_ARGS = ["-S", "dfs", "-regextype", "findutils-default"] as const;

const UGREP_DEFAULT_ARGS = [
  "-G",
  "--ignore-files",
  "--hidden",
  "-I",
  "--exclude-dir=.git",
  "--exclude-dir=.svn",
  "--exclude-dir=.hg",
  "--exclude-dir=.bzr",
  "--exclude-dir=.jj",
  "--exclude-dir=.sl",
] as const;

export function applyEmbeddedSearchPrelude(
  command: string,
  prelude?: ExecutionEmbeddedSearchPrelude,
  options: EmbeddedSearchPreludeOptions = {},
): string {
  const content = buildEmbeddedSearchPreludeContent(prelude, options);
  return content ? [content, command].join("\n") : command;
}

export function buildEmbeddedSearchPreludeContent(
  prelude?: ExecutionEmbeddedSearchPrelude,
  options: EmbeddedSearchPreludeOptions = {},
): string | undefined {
  if (prelude?.kind !== "embedded-search") return undefined;
  if (!supportsPosixShellFunctionPrelude(options.shellDialect)) return undefined;

  const backend = normalizeBackendForShell(prelude.backend, options.shellDialect);
  // Windows 不分发 bfs；Git Bash 必须保留系统 find，不能只因存在 fallback 就覆盖用户定义。
  const shouldWrapFind = options.shellDialect !== "git-bash";
  const content =
    prelude.findAndGrepEnabled === false
      ? []
      : [
          ...(shouldWrapFind ? ["unalias find 2>/dev/null || true"] : []),
          "unalias grep 2>/dev/null || true",
          ...(shouldWrapFind ? [createFindFunction(backend)] : []),
          createGrepFunction(backend),
        ];
  const ripgrepFallback = createRipgrepFallback(backend);
  if (ripgrepFallback) content.push(ripgrepFallback);
  return content.join("\n");
}

function supportsPosixShellFunctionPrelude(
  shellDialect: EmbeddedSearchPreludeShellDialect | undefined,
): boolean {
  return shellDialect !== "cmd" && shellDialect !== "legacy-shell";
}

function normalizeBackendForShell(
  backend: EmbeddedSearchBackend,
  shellDialect: EmbeddedSearchPreludeShellDialect | undefined,
): EmbeddedSearchBackend {
  if (shellDialect !== "git-bash") return backend;

  switch (backend.kind) {
    case "native-binaries":
      return {
        ...backend,
        findCommand: normalizeGitBashPathArg(backend.findCommand),
        grepCommand: normalizeGitBashPathArg(backend.grepCommand),
        rgCommand: normalizeGitBashPathArg(backend.rgCommand),
      };
    case "internal-cli":
    case "argv0-dispatch":
      return {
        ...backend,
        command: normalizeGitBashPathArg(backend.command),
        args: backend.args?.map(normalizeGitBashPathArg),
      };
  }
}

function normalizeGitBashPathArg(value: string): string {
  return isWindowsAbsolutePath(value) ? windowsPathToGitBashPath(value) : value;
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[/\\]/u.test(value) || value.startsWith("\\\\");
}

function createFindFunction(backend: EmbeddedSearchBackend): string {
  switch (backend.kind) {
    case "internal-cli":
      return createFunction(
        "find",
        backend.command,
        `${createCommandInvocation(backend)} find "$@"`,
      );
    case "argv0-dispatch":
      return createFunction(
        "find",
        backend.command,
        `ARGV0=bfs ${createCommandInvocation(backend)} ${BFS_DEFAULT_ARGS.join(" ")} "$@"`,
      );
    case "native-binaries":
      return createFunction(
        "find",
        backend.findCommand,
        `command ${shellQuote(backend.findCommand)} ${BFS_DEFAULT_ARGS.join(" ")} "$@"`,
      );
  }
}

function createGrepFunction(backend: EmbeddedSearchBackend): string {
  switch (backend.kind) {
    case "internal-cli":
      return createFunction(
        "grep",
        backend.command,
        `${createCommandInvocation(backend)} grep "$@"`,
      );
    case "argv0-dispatch":
      return createFunction(
        "grep",
        backend.command,
        `ARGV0=ugrep ${createCommandInvocation(backend)} ${UGREP_DEFAULT_ARGS.join(" ")} "$@"`,
      );
    case "native-binaries":
      return createFunction(
        "grep",
        backend.grepCommand,
        `command ${shellQuote(backend.grepCommand)} ${UGREP_DEFAULT_ARGS.join(" ")} "$@"`,
      );
  }
}

function createRipgrepFallback(backend: EmbeddedSearchBackend): string | undefined {
  let backendCommand: string;
  let invocation: string;

  switch (backend.kind) {
    case "internal-cli":
      // 兼容 backend 没有原生 rg；不能恢复无法保留 stdin 的 Node/WASM 转发路径。
      return undefined;
    case "argv0-dispatch":
      backendCommand = backend.command;
      invocation = `ARGV0=rg ${createCommandInvocation(backend)} "$@"`;
      break;
    case "native-binaries":
      // 同名 rg 不是独立 fallback：外层检查已经证明 shell 里没有可执行 rg。
      // 此时再定义 rg function 会让 command -v 误报可用，但调用仍只能失败。
      if (backend.rgCommand === "rg") return undefined;
      backendCommand = backend.rgCommand;
      invocation = `command ${shellQuote(backend.rgCommand)} "$@"`;
      break;
  }

  return [
    "if ! (unalias rg 2>/dev/null; command -v rg) >/dev/null 2>&1; then",
    "  unalias rg 2>/dev/null || true",
    indentShellContent(createFunction("rg", backendCommand, invocation)),
    "fi",
  ].join("\n");
}

function createFunction(
  name: "find" | "grep" | "rg",
  backendCommand: string,
  invocation: string,
): string {
  return [
    `${name}() {`,
    ...(name === "grep" ? createGrepBypassLines() : []),
    `  command -v ${shellQuote(backendCommand)} >/dev/null 2>&1 || { command ${name} "$@"; return; }`,
    `  ${invocation}`,
    "}",
  ].join("\n");
}

function indentShellContent(content: string): string {
  return content
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

function createGrepBypassLines(): string[] {
  return [
    "  local _zcode_grep_arg",
    '  for _zcode_grep_arg in "$@"; do',
    `    case "$_zcode_grep_arg" in ${GREP_BYPASS_CASE_PATTERN}) command grep "$@"; return ;; esac`,
    "  done",
  ];
}

function createCommandInvocation(backend: EmbeddedSearchCommandBackend): string {
  return [
    ...Object.entries(backend.env ?? {}).map(([name, value]) =>
      createShellEnvAssignment(name, value),
    ),
    "command",
    shellQuote(backend.command),
    ...(backend.args ?? []).map(shellQuote),
  ].join(" ");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function createShellEnvAssignment(name: string, value: string): string {
  return `${name}=${shellQuote(value)}`;
}
