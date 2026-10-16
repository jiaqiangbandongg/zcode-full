// ============================================================
// 世界读取的执行侧（Boundary B 的 executeWorldRead）
// ============================================================
// 从 workflow-driver.ts 里分出来的一半。driver 那边是 actor 会话、turn 编排与 submit 桥接；
// 这边是"把一个 (op, args) 变成一次真实的只读观察"——两者唯一的接触面是
// {@link executeWorldRead}，且这一半完全不碰会话、模型与 journal。
//
// 三件事在这里，而且只在这里：
//   1. **每个 op 的元数与实参校验**。Boundary A 的 `worldRead(siteId, op, args)` 只承诺
//      "实参按位置原样送达"（lowering 不看 op），所以"一个 pattern / 一个 base ref 长什么样"
//      归这一侧。
//   2. **上限的执行**。常量在纯包（`@zcode/dynamic-workflow` 的 WORLD_READ_CAPS），执行在这里，
//      因为只有这一侧能"不生产"——让 ripgrep 在 2000 条上停手，胜过物化一百万条再回头量。
//   3. **git 的固定 argv**。构造在 workflow-git-world-read.ts（纯），spawn 在这里。

import {
  isAbsolute as isAbsolutePath,
  relative as relativePath,
  resolve as resolvePath,
  sep,
} from "node:path";
import type { ExecutionPort, FileSystemPort } from "@zcode/contracts";
import { WORLD_READ_CAPS, WorkflowError, type WorldReadOp } from "@zcode/dynamic-workflow";
import {
  GIT_SHOW_PREFIX_ARGV,
  GIT_STATUS_ARGV,
  gitChangedFilesPlan,
  gitDiffArgv,
  gitLogArgv,
  parseGitLog,
  parseGitPathList,
  parseGitShowPrefix,
  parseGitStatusPorcelainV2,
  type GitCommitResult,
  type GitStatusResult,
} from "./workflow-git-world-read.js";

/** 世界读取需要的端口与基准目录（driver deps 的一个子集）。 */
export interface WorldReadDeps {
  /** files.glob / files.read / files.grep 落到的文件系统端口。 */
  readonly fileSystemPort: FileSystemPort;
  /** git.* 落到的子进程执行端口（cwd = 工作区根）。 */
  readonly executionPort: ExecutionPort;
  /** 路径解析与相对化的基准目录（workspace 根）。 */
  readonly cwd: string;
}

/**
 * 按 op 从**位置实参数组**里取参并执行一次世界读取。Boundary A 只承诺"实参按位置原样送达"
 * （lowering 不看 op），所以每个 op 的元数与类型校验就在这里——这一侧才是知道
 * "一个 pattern / 一个 base ref 长什么样"的那一侧。
 * 形状不符一律以结构化 `DriverError` 拒绝该节点，绝不静默强转：一个被 `String(undefined)`
 * 悄悄变成 `"undefined"` 的路径，会读出一个查不明白的失败，而不是一条能改的错误。
 *
 * 声明成 `async` 是有意的：实参校验的抛错必须变成**该节点的 promise 拒绝**。同步抛错会从
 * `engine.worldRead` 里穿出去（引擎在准入落 journal 之后才 `.then(...)`），留下一个永远
 * running 的节点。
 */
export async function executeWorldRead(
  deps: WorldReadDeps,
  op: WorldReadOp,
  args: unknown[],
): Promise<unknown> {
  switch (op) {
    case "glob":
      return await worldGlob(deps, worldReadStringArgs(op, args, ["pattern"])[0]!);
    case "read":
      return await worldRead(deps, worldReadStringArgs(op, args, ["path"])[0]!);
    case "grep": {
      const [pattern, glob] = worldReadOptionalStringArgs(op, args, ["pattern"], ["glob"]);
      return await worldGrep(deps, pattern!, glob);
    }
    case "git-changed-files": {
      const [base] = worldReadOptionalStringArgs(op, args, [], ["base"]);
      return await gitChangedFiles(deps, base);
    }
    case "git-diff": {
      const [base, path] = worldReadOptionalStringArgs(op, args, [], ["base", "path"]);
      return await gitDiff(deps, base, path);
    }
    case "git-status": {
      // 无参 op：`names` 为空即"恰好 0 个实参"，多传一个仍然大声失败。
      worldReadStringArgs(op, args, []);
      return await gitStatus(deps);
    }
    case "git-log":
      return await gitLog(deps, worldReadOptionalCount(op, args, "count"));
    case "run":
      return await worldRun(deps, args);
    default: {
      // op 词汇表由 world-read 注册表推导：新增一行而这里没接上，就会落到这里大声失败。
      const unknownOp: never = op;
      throw new WorkflowError("DriverError", `Unsupported world-read op "${String(unknownOp)}".`);
    }
  }
}

/**
 * `files.glob(pattern)`：经 FileSystemPort 的 searchFiles，归一成 facade 承诺的形状。
 *
 * 三步归一都来自端口语义与 facade 承诺的落差——端口结果不能原样交出。
 * 端口是为 UI 的 Glob 工具设计的：绝对路径、mtime 降序、默认 100 条截断。
 *
 * - **cap+1 拒绝**（与 worldGrep 同一惯用法）：端口的默认截断静默生效过，一次 5000 文件
 *   的 glob 只交出 2%，且错误视图会进 journal 被 resume 重放。cap 归 WORLD_READ_CAPS
 *   所有，恰好 cap 条无从区分"正好"与"被截断"，故多要一条。
 * - **工作区相对化**：绝对路径让脚本按工作区相对前缀写的路由（`startsWith("apps/…")`）
 *   全部落空，把 6 路扇出静默坍缩成 1 路；grep/git 早已相对化，glob 是漏网的那个。
 * - **字典序重排**：mtime 随任何一次写文件漂移，journaled 值必须确定——同一脚本两次
 *   提交不该扇出在不同的次序上。拒绝语义保证到这里手上必是全量匹配，重排是完备的。
 */
async function worldGlob(deps: WorldReadDeps, pattern: string): Promise<string[]> {
  const cap = WORLD_READ_CAPS.globMaxFiles;
  const result = await deps.fileSystemPort.searchFiles({
    path: deps.cwd,
    pattern,
    maxResults: cap + 1,
  });
  if (result.files.length > cap || result.truncated) {
    throw capExceeded(`files.glob: over ${cap} files match (the cap). Narrow the pattern.`);
  }
  return result.files.map((path) => toWorkspaceRelative(deps.cwd, path)).sort();
}

/**
 * `files.read(path)`：解析到绝对路径后**先确认它仍在工作区之内**，再交给端口。
 *
 * 为什么这道检查现在才补上：在 `git.*` 落地之前，能进到这里的路径都是脚本自己写出来的字面量，
 * 越界是一次显式的越界。`git.*` 是第一个**能生产出**路径的原语——`changedFiles() → files.read(p)`
 * 是那个最显然的两行组合，而 git 的原生输出在工作区是仓库子目录时会带 `../` 前缀。git 那一侧
 * 已经用 pathspec 把范围收在工作区内了，这道检查是同一条不变式在另一端的落点：一个原语的
 * 显然组合不该是个陷阱。
 */
async function worldRead(deps: WorldReadDeps, arg: string): Promise<string> {
  const path = assertWithinWorkspace("read", deps.cwd, arg);
  const result = await deps.fileSystemPort.readTextFile({ path });
  return result.content;
}

/**
 * `files.grep(pattern, glob?)`：经 FileSystemPort 的 searchText（ripgrep 语义）。
 *
 * **headLimit 取 cap + 1**，这是本方法唯一不显然的一行。上限是"命中超过 cap 就拒绝"，
 * 而端口只会按 headLimit 截断——所以刚好取 cap 会得到一个歧义结果：cap 条命中，既可能是
 * 正好 cap 条（应当放行），也可能是被截掉了后面一百万条（应当拒绝）。多取一条就把这个
 * 歧义消掉了：拿到 cap+1 条即确知溢出，而代价仍然只有一条记录，不必物化整个结果集。
 * `truncated` 是同一判断的第二条线（端口若因别的原因截断，我们手上就不是完整结果了）。
 */
async function worldGrep(
  deps: WorldReadDeps,
  pattern: string,
  glob: string | undefined,
): Promise<GrepMatch[]> {
  const cap = WORLD_READ_CAPS.grepMaxMatches;
  const result = await deps.fileSystemPort.searchText({
    path: deps.cwd,
    pattern,
    ...(glob === undefined ? {} : { glob }),
    outputMode: "content",
    showLineNumbers: true,
    headLimit: cap + 1,
  });
  if (result.entries.length > cap || result.truncated) {
    throw capExceeded(
      `files.grep: over ${cap} matches (the cap). Narrow the pattern or add a glob.`,
    );
  }
  const matches: GrepMatch[] = [];
  for (const entry of result.entries) {
    // content 模式下每条命中都带行号与行文本；缺其一的条目不是一条内容命中（例如端口在
    // 别的 outputMode 下产出的计数项），跳过而不是填 0 / "" 造一条假命中。
    if (entry.lineNumber === undefined || entry.text === undefined) continue;
    matches.push({
      path: toWorkspaceRelative(deps.cwd, entry.path),
      line: entry.lineNumber,
      text: entry.text,
    });
  }
  const serializedBytes = Buffer.byteLength(JSON.stringify(matches), "utf8");
  if (serializedBytes > WORLD_READ_CAPS.grepMaxSerializedBytes) {
    throw capExceeded(
      `files.grep: result is ${serializedBytes} bytes, over the ` +
        `${WORLD_READ_CAPS.grepMaxSerializedBytes}-byte cap. Narrow the pattern or add a glob.`,
    );
  }
  return matches;
}

// ——————————————————————————————— 内部：git.* world-read ———————————————————————————————

/**
 * 跑一条 git 命令并返回 stdout。argv 由 workflow-git-world-read.ts **构造**（固定数组，
 * 永不 shell 字符串），本方法只负责交给端口并把失败归一成 node 级 `DriverError`。
 *
 * `maxInlineBytes` 由调用方给：git.diff 要用它做上限探测（同 grep 的 cap+1 手法），
 * 其余 op 用一个够大的缺省值。
 */
async function runGit(
  deps: WorldReadDeps,
  op: WorldReadOp,
  argv: readonly string[],
  maxInlineBytes: number,
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const result = await deps.executionPort.run({
    command: { mode: "argv", file: "git", args: [...argv] },
    cwd: deps.cwd,
    outputLimit: { maxInlineBytes },
  });
  if (result.status !== "completed" || (result.exitCode ?? 0) !== 0) {
    // git 缺失、非仓库、坏 ref 都走这里。归一成**可 catch 的** DriverError 而不是 run 级
    // 失败，使脚本可以通过 try/catch 改用 files.glob。
    const detail = firstLine(result.stderr.text) || firstLine(result.stdout.text) || result.status;
    throw new WorkflowError(
      "DriverError",
      `git ${argv.join(" ")} failed (${result.status}, exit=${result.exitCode ?? "n/a"}): ${detail}`,
    );
  }
  return {
    text: result.stdout.text,
    bytes: result.stdout.bytes,
    truncated: result.stdout.truncated,
  };
}

/**
 * 工作区相对仓库根的前缀（仓库根时为空串）。线上的路径一律是仓库根相对的，剥掉这个前缀
 * 才是 facade 承诺的工作区相对路径（见 workflow-git-world-read.ts 顶部的输出契约 2）。
 *
 * 每次读取都问一次而不做缓存：一次 `rev-parse` 是毫秒级的，而世界读取按 site×ordinal
 * 只发生一次并落 journal，不在任何热路径上。换来的是这一侧完全无状态。
 */
async function gitWorkspacePrefix(deps: WorldReadDeps, op: WorldReadOp): Promise<string> {
  const out = await runGit(deps, op, GIT_SHOW_PREFIX_ARGV, GIT_TEXT_OUTPUT_BYTES);
  return parseGitShowPrefix(out.text);
}

async function gitChangedFiles(deps: WorldReadDeps, base: string | undefined): Promise<string[]> {
  // 先构造 argv：base 不合法时应当在**跑任何 git 之前**就拒绝。
  const plans = gitChangedFilesPlan(base);
  const prefix = await gitWorkspacePrefix(deps, "git-changed-files");
  const paths: string[] = [];
  for (const plan of plans) {
    const out = await runGit(deps, "git-changed-files", plan.argv, GIT_TEXT_OUTPUT_BYTES);
    paths.push(...parseGitPathList(out.text, prefix));
  }
  // 并集去重并排序：两条命令可以报出同一个路径，且 journal 存的是这个值，所以它必须只
  // 依赖内容、不依赖两条命令谁先返回。
  return [...new Set(paths)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

async function gitDiff(
  deps: WorldReadDeps,
  base: string | undefined,
  path: string | undefined,
): Promise<string> {
  const cap = WORLD_READ_CAPS.gitDiffMaxBytes;
  // cap + 1：同 grep 的理由——"正好 cap 字节"与"被截断"必须可区分。
  const out = await runGit(deps, "git-diff", gitDiffArgv(base, path), cap + 1);
  if (out.bytes > cap || out.truncated) {
    throw capExceeded(
      `git.diff: output is ${out.bytes} bytes, over the ${cap}-byte cap. Pass a path to narrow.`,
    );
  }
  return out.text;
}

async function gitStatus(deps: WorldReadDeps): Promise<GitStatusResult> {
  const prefix = await gitWorkspacePrefix(deps, "git-status");
  const out = await runGit(deps, "git-status", GIT_STATUS_ARGV, GIT_TEXT_OUTPUT_BYTES);
  return parseGitStatusPorcelainV2(out.text, prefix);
}

async function gitLog(deps: WorldReadDeps, count: number): Promise<GitCommitResult[]> {
  const out = await runGit(deps, "git-log", gitLogArgv(count), GIT_TEXT_OUTPUT_BYTES);
  return parseGitLog(out.text);
}

// ——————————————————————————————— 内部：world.run ———————————————————————————————

/** `world.run` 的返回值。权威声明是 FACADE_DTS 里的 `declare interface WorldRunResult`。 */
interface WorldRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * `world.run(cmd, args?, opts?)`：journal 化命令执行。
 *
 * 与 `git.*` 的三个刻意差异，每个都是契约而非疏忽：
 *   1. **非零退出是值**。执行适配器把非零退出映射成 `status:"failed"` 且 `error` 缺席
 *      （node-execution-adapter-results.ts 的 statusFromExit/statusFailure），据此与
 *      spawn 失败 / 超时可靠区分。门控循环的常态路径不该走异常控制流。
 *   2. **没有运行期命令白名单**。授权只在编译期：cmd 必须是字面量（9003），脚本能跑的命令
 *      因此在提交前就全部可读、确认图逐条展示。这里曾经再拿一份 launch 时从种子脚本收集的
 *      `declaredRunCommands` 复验一遍（"只防接线错误"）——但补全（FillWorkflowHole）编译的是
 *      有效脚本，driver 手里的集合却还是种子那份，函数体里第一次出现的命令就被当"接线错误"
 *      拒掉了。lowering 跑的就是脚本自己的文本，补全的 code 也是有效脚本自己的 lowering，
 *      那份复验防不住任何真实情况，只多出一个要手工同步的第二数据源，故删除。
 *   3. **超时无上限**。缺省 300s，脚本可任意加大（为真正长跑的测试设计）；
 *      cancel 仍是最后的控制。
 *
 * stdout/stderr 各 256KB，cap+1 探测（`maxInlineBytes` 按两 cap 之大者 +1，随后逐流判定），
 * 超限拒绝不截断——message 给出可操作的下一步，与 grep/diff 同一 house policy。
 */
async function worldRun(deps: WorldReadDeps, args: unknown[]): Promise<WorldRunResult> {
  const { argv, cmd, timeoutMs } = worldRunArgs(args);

  const stdoutCap = WORLD_READ_CAPS.runStdoutMaxBytes;
  const stderrCap = WORLD_READ_CAPS.runStderrMaxBytes;
  const result = await deps.executionPort.run({
    command: { mode: "argv", file: cmd, args: argv },
    cwd: deps.cwd,
    timeoutMs,
    outputLimit: { maxInlineBytes: Math.max(stdoutCap, stderrCap) + 1 },
  });

  if (result.status === "timed_out") {
    throw new WorkflowError(
      "DriverError",
      `world.run '${cmd}' timed out after ${timeoutMs}ms. Raise opts.timeoutMs or narrow the work.`,
    );
  }
  // completed（exit 0）与 failed-无-error（非零退出）都是**跑完了的观察**，交出值；
  // 其余（spawn_error / cancelled / 带 error 的 failed，如 output_limit）是观察本身没成立。
  const ranToExit =
    result.status === "completed" ||
    (result.status === "failed" &&
      result.error === undefined &&
      typeof result.exitCode === "number");
  if (!ranToExit) {
    const detail = result.error?.message ?? (firstLine(result.stderr.text) || result.status);
    throw new WorkflowError(
      "DriverError",
      `world.run '${cmd}' did not run to completion (${result.status}): ${detail}`,
    );
  }

  if (result.stdout.bytes > stdoutCap || result.stdout.truncated) {
    throw capExceeded(
      `world.run '${cmd}': stdout is ${result.stdout.bytes} bytes, over the ${stdoutCap}-byte cap. ` +
        `Quiet the output (e.g. --quiet), or write a file and files.read a summary.`,
    );
  }
  if (result.stderr.bytes > stderrCap || result.stderr.truncated) {
    throw capExceeded(
      `world.run '${cmd}': stderr is ${result.stderr.bytes} bytes, over the ${stderrCap}-byte cap. ` +
        `Reduce the diagnostics, or write a file and files.read a summary.`,
    );
  }

  return {
    exitCode: result.exitCode ?? 0,
    stdout: result.stdout.text,
    stderr: result.stderr.text,
  };
}

/**
 * `world.run` 的实参形状：`[cmd: string, args?: string[], opts?: { timeoutMs?: number }]`。
 * 与 {@link worldReadStringArgs} 同一纪律（大声失败、绝不强转），但形状（数组 + 选项袋）
 * 超出了 string 序列助手的表达面，所以单列。
 */
function worldRunArgs(args: unknown[]): { cmd: string; argv: string[]; timeoutMs: number } {
  if (args.length < 1 || args.length > 3) {
    throw new WorkflowError(
      "DriverError",
      `world.run takes 1 to 3 arguments (cmd, args?, opts?), got ${args.length}.`,
    );
  }
  const cmd = requireStringArg("run", args[0], "cmd", 0);

  const rawArgv = args[1];
  let argv: string[] = [];
  if (rawArgv !== undefined) {
    if (!Array.isArray(rawArgv)) {
      throw new WorkflowError(
        "DriverError",
        `world.run: argument 2 (args) must be an array of strings, got ${describeArg(rawArgv)}.`,
      );
    }
    argv = rawArgv.map((item, index) => {
      if (typeof item !== "string") {
        throw new WorkflowError(
          "DriverError",
          `world.run: args[${index}] must be a string, got ${describeArg(item)}. Stringify values.`,
        );
      }
      return item;
    });
  }

  const rawOpts = args[2];
  let timeoutMs: number = WORLD_READ_CAPS.runDefaultTimeoutMs;
  if (rawOpts !== undefined) {
    if (typeof rawOpts !== "object" || rawOpts === null || Array.isArray(rawOpts)) {
      throw new WorkflowError(
        "DriverError",
        `world.run: arg 3 (opts) must be an options object or omitted, got ${describeArg(rawOpts)}.`,
      );
    }
    const rawTimeout = (rawOpts as { timeoutMs?: unknown }).timeoutMs;
    if (rawTimeout !== undefined) {
      if (typeof rawTimeout !== "number" || !Number.isInteger(rawTimeout) || rawTimeout < 1) {
        throw new WorkflowError(
          "DriverError",
          `world.run: opts.timeoutMs must be an integer >= 1, got ${describeArg(rawTimeout)}.`,
        );
      }
      // 刻意无上限钳制：为真正长跑的测试设计；cancel 是最后的控制。
      timeoutMs = rawTimeout;
    }
  }

  return { argv, cmd, timeoutMs };
}

// ——————————————————————————————— 纯辅助 ———————————————————————————————

/**
 * 从 world-read 的位置实参数组里取出 `names` 所描述的**必填 string 实参**，形状不符即抛结构化
 * `DriverError`（node 级失败，脚本可 `catch`）。元数按 `names.length` 精确校验：多传的实参只可能
 * 来自接线错误——facade 的类型签名在编译期就拦住了多余实参，所以运行期出现就是 lowering /
 * 线协议出了岔子，静默忽略等于把一个可定位的 bug 藏成一次语义不明的读取。
 *
 * 为什么校验而不强转：Boundary A 的 `args: unknown[]` 是**原样透传**的脚本实参，这一侧是第一个
 * 也是唯一一个知道每个 op 元数的地方。
 * `String(args[0])` 会把 `undefined` 变成路径 `"undefined"`，报出的 ENOENT 指不回真正的错处。
 *
 * 带可选实参的多参 op（`files.grep(pattern, glob?)`、`git.diff(base?, path?)`）走的是允许尾部
 * 缺省的变体 {@link worldReadOptionalStringArgs}；接缝在这两个函数里，不在调用点。
 */
function worldReadStringArgs(op: WorldReadOp, args: unknown[], names: readonly string[]): string[] {
  if (args.length !== names.length) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op} takes ${names.length} arguments (${names.join(", ")}), got ${args.length}.`,
    );
  }
  return names.map((name, index) => requireStringArg(op, args[index], name, index));
}

/**
 * {@link worldReadStringArgs} 的**尾部可选**变体：`required` 是必填前缀，`optional` 是可选尾部。
 * 返回定长 `required.length + optional.length` 的数组，缺席的可选位是 `undefined`。
 *
 * 三条规则，都是"大声失败"的一面：
 *   1. 实参数少于必填数、或多于总数 → 结构化 `DriverError`。多传仍然拒绝，理由与精确变体
 *      相同：facade 的签名在编译期就拦住了多余实参，运行期出现只可能是 lowering / 线协议的
 *      接线错误，静默忽略等于把一个可定位的 bug 藏成一次语义不明的读取。
 *   2. 必填位必须是 string。
 *   3. **可选位允许显式 `undefined`**，因为它在脚本里是可写的：`git.diff(undefined, "a.ts")`
 *      在 `base?: string` 下合法，lowering 原样按位置打包，于是 driver 真的会收到一个
 *      `undefined` 前缀。把它当成"缺席"是唯一说得通的读法。
 *
 * 注意 lowering 对**尾部**缺省打包的是**更短的数组**（不是 undefined 洞），而
 * `inputHash({op, args})` 是 journal 键——所以 `["TODO"]` 与 `["TODO", "*.ts"]` 天然是两个键。
 * 本函数只把两种到达形态都归一成同一个调用形状，不去改写 args。
 */
function worldReadOptionalStringArgs(
  op: WorldReadOp,
  args: unknown[],
  required: readonly string[],
  optional: readonly string[],
): (string | undefined)[] {
  const max = required.length + optional.length;
  if (args.length < required.length || args.length > max) {
    const range = required.length === max ? `${max}` : `${required.length}~${max}`;
    throw new WorkflowError(
      "DriverError",
      `world-read ${op} takes ${range} arguments ` +
        `(${[...required, ...optional.map((n) => `${n}?`)].join(", ")}), got ${args.length}.`,
    );
  }
  const out: (string | undefined)[] = [];
  required.forEach((name, index) => out.push(requireStringArg(op, args[index], name, index)));
  optional.forEach((name, offset) => {
    const index = required.length + offset;
    if (index >= args.length) {
      out.push(undefined);
      return;
    }
    const value = args[index];
    if (value === undefined) {
      out.push(undefined);
      return;
    }
    out.push(requireStringArg(op, value, name, index));
  });
  return out;
}

/**
 * `git.log(count?)` 的实参：0 或 1 个，必须是正整数且不超过上限。缺席取
 * {@link WORLD_READ_CAPS.gitLogDefaultCount}。
 *
 * 超上限**拒绝**而不是静默夹到上限：脚本请求 500 条却拿到 100 条，会在它自己的逻辑里变成
 * 一个查不明白的"历史怎么这么短"。一条指名上限的错误让脚本能直接改对。
 */
function worldReadOptionalCount(op: WorldReadOp, args: unknown[], name: string): number {
  const max = WORLD_READ_CAPS.gitLogMaxCount;
  if (args.length > 1) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op} takes at most 1 argument (${name}?), got ${args.length}.`,
    );
  }
  const raw = args[0];
  if (raw === undefined) return WORLD_READ_CAPS.gitLogDefaultCount;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: argument '${name}' must be an integer >= 1, got ${describeArg(raw)}.`,
    );
  }
  if (raw > max) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: argument '${name}'=${raw} is over the cap of ${max}; pass at most ${max}.`,
    );
  }
  return raw;
}

/** 取一个必须是 string 的位置实参，否则结构化拒绝（绝不 `String(...)` 强转）。 */
function requireStringArg(op: WorldReadOp, value: unknown, name: string, index: number): string {
  if (typeof value !== "string") {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: arg ${index + 1} (${name}) must be a string, got ${describeArg(value)}.`,
    );
  }
  return value;
}

/**
 * 上限溢出的结构化拒绝。message 一律带**可操作的下一步**（"缩窄 pattern 或加一个 glob"）：
 * 上限是脚本可以据以重写自己的契约，一条只说"超了"的错误把这一点浪费掉。
 */
function capExceeded(message: string): WorkflowError {
  return new WorkflowError("WorldReadCapExceeded", message);
}

/**
 * 把一个脚本给的相对路径解析成绝对路径，并**词法上**判定它是否仍在工作区之内；越界返回
 * `undefined`（错误的措辞与结构化码归调用方——世界读取报 `DriverError`，产物发布报
 * `ArtifactPathOutsideWorkspace`）。
 *
 * 判据用 `relative(cwd, resolved)`：它的输出已经规范化，`..` 只可能出现在开头，所以
 * "不以 `..` 段开头且不是绝对路径"就等价于"仍在工作区内"。第二个条件在 windows 上是必需的
 * ——跨盘符时 `relative` 会返回一个绝对路径而不是一串 `..`。
 *
 * **只做词法检查，不追符号链接**：工作区内一个指向外部的软链在这一层仍然通过。世界读取
 * 接受这条已知边界（读出来的字节就是脚本自己看到的值）；产物发布不接受它，因为它把字节
 * **拷进一个持久 store 交给用户**，所以那一侧在本函数之上再做一次 realpath 复核
 * （见 workflow-artifact-publish.ts）。
 *
 * **导出是有意的**：越界的定义必须只有一个实现。两处各写一遍，就会有一天两处对同一个
 * 路径给出不同答案，而其中一处是安全边界。
 */
export function resolveWithinWorkspace(cwd: string, arg: string): string | undefined {
  const resolved = resolvePath(cwd, arg);
  const rel = relativePath(cwd, resolved);
  const escapes = rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith("../");
  return escapes || isAbsolutePath(rel) ? undefined : resolved;
}

/** {@link resolveWithinWorkspace} 的世界读取包装：越界即结构化 `DriverError`（脚本可 `catch`）。 */
function assertWithinWorkspace(op: string, cwd: string, arg: string): string {
  const resolved = resolveWithinWorkspace(cwd, arg);
  if (resolved === undefined) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: path '${arg}' is outside the workspace; pass a path inside it.`,
    );
  }
  return resolved;
}

/**
 * 端口返回的路径归一成**工作区相对**路径（facade 承诺的形状）。端口可能给绝对路径也可能
 * 已经给相对路径，两种都接。分隔符统一成 `/`：这个值会进 journal、也会被插值进模型提示，
 * 所以它不该随宿主平台变形（同一份脚本在 windows 与 mac 上应当读出同样的 path）。
 *
 * **导出是有意的**（同 {@link resolveWithinWorkspace}）：产物记录里的 `sourcePath` 是同一种
 * 值——工作区相对、正斜杠——而"同一种值"必须只有一处定义，否则两处迟早会在 windows 上分叉。
 */
export function toWorkspaceRelative(cwd: string, path: string): string {
  const rel = resolvePath(cwd, path) === path ? relativePath(cwd, path) : path;
  return rel.replace(/\\/g, "/");
}

/** stderr / stdout 的首行（错误消息用，不回显整段输出）。 */
function firstLine(text: string): string {
  return text.split("\n", 1)[0]?.trim() ?? "";
}

/**
 * git 文本输出（路径列表 / status / log）的 inline 上限。这些 op 没有 spec 级上限，但一个
 * 无界 buffer 不是选项——100 个 commit 与一棵工作树的路径列表离 4MB 有几个数量级。
 * git.diff **不**用这个值：它有自己的 512KB 上限，且要靠 cap+1 做溢出探测。
 */
const GIT_TEXT_OUTPUT_BYTES = 4 * 1024 * 1024;

/** `files.grep` 的一条命中。权威声明是 FACADE_DTS 里的 `declare interface GrepMatch`。 */
interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

/** 实参形状的简短描述（只用于错误消息，不回显完整内容）。 */
function describeArg(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  return Array.isArray(value) ? "array" : typeof value;
}
