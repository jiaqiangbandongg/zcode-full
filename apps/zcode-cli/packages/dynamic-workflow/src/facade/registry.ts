import ts from "typescript";
import { FACADE_FILE_NAME } from "./dts.js";

/**
 * world-read 注册表：
 * **(facade 容器, 成员) → op** 的唯一真源。一张表，三个消费方——`analysis/sites.ts` 的站点收集、
 * `analysis/facade-misuse.ts` 的 facade-siting 诊断、`lowering/lower.ts` 的改写——所以加一个
 * world-read 原语就是**加一行**，消费方一行不改。
 *
 * ————————————————————————————————————————————————————————————————
 * 为什么键上必须带**声明容器**，而不能只用成员名
 * ————————————————————————————————————————————————————————————————
 * `git.log` 与顶层 `log()` 撞名。裸名字集合只有两种下场：给每一条进度消息都铸出一个
 * world-read 站点，或者把 `git.log` 的站点整个丢掉——而没有站点的 facade 调用就没有 journal
 * 键，正是 facade-siting 规则存在的意义所要防的那种不可靠。facade 身份在别处早就是
 * **按声明判定**的（misuse pass 解析 callee 的 symbol，而非它的拼写），所以这里只是把同一条
 * 规则一致地用上，而不是新增规则。
 *
 * op 联合类型由表**推导**（见 {@link WorldReadOp}）：新增一行即扩张 Boundary A 的 op 词汇表，
 * 不必再改一处类型声明——那是第二份真相的常见起点。
 */

/** 注册表一行：facade 容器上的一个成员，映射到 Boundary A 的一个 op。 */
interface WorldReadRow {
  /** 声明该成员的 facade 容器名（`declare const files: {...}` 的 `files`）。 */
  readonly container: string;
  /** 容器上的成员名（`files.glob` 的 `glob`）。 */
  readonly member: string;
  /** Boundary A 的 op 名。与成员名**不必**相同：`git.log` → `"git-log"`。 */
  readonly op: string;
}

/**
 * world-read 注册表。加原语=加一行。
 *
 * `git.log` 那一行是这张表存在的理由：它的成员名与顶层 `log()` 撞名，而这里的键带容器，
 * 所以两者从不相遇（见本模块顶部）。
 */
export const WORLD_READ_REGISTRY = [
  { container: "files", member: "glob", op: "glob" },
  { container: "files", member: "read", op: "read" },
  { container: "files", member: "grep", op: "grep" },
  { container: "git", member: "changedFiles", op: "git-changed-files" },
  { container: "git", member: "diff", op: "git-diff" },
  { container: "git", member: "status", op: "git-status" },
  { container: "git", member: "log", op: "git-log" },
  // world.run：journal 化命令执行。同一张表、同一套
  // 机制——「读」与「效应」的差别在授权面（编译期字面量 cmd + 确认窗）与 journal 的
  // 节点种类（world-run），不在站点身份。
  { container: "world", member: "run", op: "run" },
] as const satisfies readonly WorldReadRow[];

/**
 * 世界读取操作（只读、可 journal）。从注册表推导，故加一行即扩张 op 词汇表。
 * Boundary A 的 `worldRead(siteId, op, args)` 与 journal 的 `inputHash({op, args})` 都用它。
 */
export type WorldReadOp = (typeof WORLD_READ_REGISTRY)[number]["op"];

/**
 * 产物注册表：容器 `artifact` 的六个成员
 * → Boundary A 的六个 op。与 world-read 注册表**同形但分表**，这是刻意的：
 *
 * world-read 那张表的每一行最终都落到 `driver.executeWorldRead`，语义是「读」；产物的两族
 * 一个是写 store 的效应（`publishArtifact`）、一个根本不过 driver（`declareArtifact`）。把它们
 * 混进同一张表，misuse / lowering / 引擎三处的 world-read 分支就都要背上一个「除非它其实是
 * 产物」的分叉——而那三处正是加原语时最该零改动的地方。
 *
 * ⚠ 术语：这里的 artifact 是**用户面产物**，不是引擎内部的顶层返回值。
 */
export interface ArtifactRow {
  /** 声明该成员的 facade 容器名（恒为 `artifact`）。 */
  readonly container: "artifact";
  /** 容器上的成员名。 */
  readonly member: string;
  /** Boundary A 的 op 名（与成员名相同——产物成员没有 `git.log` 那样的撞名史）。 */
  readonly op: string;
  /**
   * 成员族。`content` 是效应（async、经 driver、可拒绝），`preset` 是声明（同步 void、
   * 不经 driver）。族别决定 lowering 改写成 `publishArtifact` 还是 `declareArtifact`，
   * 也决定超限走节点拒绝还是 failRun，所以它必须和 op 住在同一行里，而不是在三处各判一次。
   */
  readonly family: "content" | "preset";
}

/** 产物注册表。加一个产物种类 = 加一行。 */
export const ARTIFACT_REGISTRY = [
  { container: "artifact", member: "file", op: "file", family: "content" },
  { container: "artifact", member: "markdown", op: "markdown", family: "content" },
  { container: "artifact", member: "chart", op: "chart", family: "preset" },
  { container: "artifact", member: "table", op: "table", family: "preset" },
  { container: "artifact", member: "metrics", op: "metrics", family: "preset" },
  { container: "artifact", member: "board", op: "board", family: "preset" },
] as const satisfies readonly ArtifactRow[];

/** 全部产物 op（六个成员）。由注册表推导，故加一行即扩张词汇表。 */
export type ArtifactOp = (typeof ARTIFACT_REGISTRY)[number]["op"];

/** 内容成员的 op（效应：async、经 driver、返回 `ArtifactRef`）。 */
export type ArtifactContentOp = Extract<
  (typeof ARTIFACT_REGISTRY)[number],
  { family: "content" }
>["op"];

/** 预置成员的 op（声明：同步 void、不经 driver）。 */
export type ArtifactPresetOp = Extract<
  (typeof ARTIFACT_REGISTRY)[number],
  { family: "preset" }
>["op"];

/**
 * 注册表查询：(容器, 成员) → 产物行。非产物成员返回 undefined。
 *
 * 返回**表元素的字面量类型**（而不是宽化的 {@link ArtifactRow}）：`op` 与 `family` 的联合
 * 类型全由这张表推导，宽化一次就等于把它们退回成 `string`，站点表与 lowering 也就跟着
 * 失去分派依据。
 */
function artifactRow(
  container: string | undefined,
  member: string,
): (typeof ARTIFACT_REGISTRY)[number] | undefined {
  if (container === undefined) return undefined;
  return ARTIFACT_REGISTRY.find((row) => row.container === container && row.member === member);
}

/** 某 facade symbol 解析到的产物行（按声明容器判定），非产物成员则 undefined。 */
export function artifactRowOfSymbol(
  symbol: ts.Symbol | undefined,
): (typeof ARTIFACT_REGISTRY)[number] | undefined {
  const member = facadeMemberOf(symbol);
  if (member === undefined) return undefined;
  return artifactRow(member.container, member.member);
}

/** 某产物 op 属于哪一族。op 由注册表推导，故这里必然命中。 */
export function artifactFamilyOf(op: ArtifactOp): "content" | "preset" {
  const row = ARTIFACT_REGISTRY.find((candidate) => candidate.op === op);
  if (row === undefined) throw new Error(`unknown artifact op: ${op}`);
  return row.family;
}

/** 该 op 是否为预置成员（声明族）。引擎与分析器都据它分派两条完全不同的路径。 */
export function isArtifactPresetOp(op: string): op is ArtifactPresetOp {
  return ARTIFACT_REGISTRY.some((row) => row.op === op && row.family === "preset");
}

/**
 * `ask` 所在的容器：不是 world-read，但同为**产生站点**的 facade 成员，故 facade-siting
 * 规则同样约束它（只允许直接调用）。放在这里是为了让"哪些成员产生站点"只有一份清单。
 */
const ASK_MEMBER = { container: "Agent", member: "ask" } as const;

/**
 * 顶层 facade 函数中产生站点的那些（无容器）。`log` 不产生站点，故不在此。`hole` 在此：留白
 * 有站点 id（名字键 `hole#<hash>`）与 host 调用（docs/dynamic-workflow/authoring.md「Holes」），身份同样按
 * **声明文件**判定——脚本自己的 `hole` 函数是别人的函数。
 */
const SITE_PRODUCING_FUNCTIONS = ["agent", "report", "hole"] as const;

/**
 * 顶层产生站点的 facade 函数名。`sites.ts` 的裸 callee 分支按它分派，所以"哪个顶层函数
 * 产生站点"这件事只有这一份清单。
 *
 * `report` 在这里、`log` 不在，两者的差别不是严重程度而是**有没有 journal 键**：
 * report 有一行 `dwf_node`（按 site × ordinal 去重 replay），所以 facade-siting 规则
 * （只许直接调用）必须约束它——一次没有站点的 report 调用就是一条没有键的 journal 记录。
 * `log` 没有站点，也就没有什么可被 aliasing 破坏。
 */
type SiteProducingFunction = (typeof SITE_PRODUCING_FUNCTIONS)[number];

/**
 * 某 facade symbol 解析到的产生站点的**顶层函数**（按声明判定：容器必须缺席）。
 * 非 facade symbol、facade 容器成员、以及 `log` 之类不产生站点的顶层函数都返回 undefined。
 */
export function siteProducingFunctionOfSymbol(
  symbol: ts.Symbol | undefined,
): SiteProducingFunction | undefined {
  const member = facadeMemberOf(symbol);
  if (member === undefined || member.container !== undefined) return undefined;
  return SITE_PRODUCING_FUNCTIONS.find((name) => name === member.member);
}

/**
 * 顶层 facade 函数中**展示用的标记**：有 facade 身份，但不产生站点。目前只有 `phase`。
 *
 * 为什么它不在 {@link SITE_PRODUCING_FUNCTIONS} 里，而是自成一列：那份清单回答的是
 * 「哪个顶层函数产生站点」，而 `phase` 没有站点 id、没有 journal 行、没有 host 调用——
 * lowering 直接把它抹成 `void 0`。把它混进产生站点的清单会让 facade-misuse 的 pass 2（"产生站点却没被 site
 * 掉的直接调用"）拒绝每一次合法的 `phase("gate")`。
 *
 * 它仍然是 facade 函数声明，所以别名逃逸（`const p = phase`）照旧被 facade-misuse 的
 * pass 1 拒绝——lowering 因此可以放心按节点身份抹除。
 */
const MARKER_FUNCTIONS = ["phase"] as const;

/** 顶层展示标记 facade 函数名。由 {@link MARKER_FUNCTIONS} 推导，加一个标记即加一行。 */
type MarkerFunction = (typeof MARKER_FUNCTIONS)[number];

/**
 * 某 facade symbol 解析到的**展示标记**顶层函数（按声明判定：容器必须缺席），
 * 非标记则 undefined。与 {@link siteProducingFunctionOfSymbol} 同形、刻意不同表。
 */
export function markerFunctionOfSymbol(
  symbol: ts.Symbol | undefined,
): MarkerFunction | undefined {
  const member = facadeMemberOf(symbol);
  if (member === undefined || member.container !== undefined) return undefined;
  return MARKER_FUNCTIONS.find((name) => name === member.member);
}

/**
 * 顶层 facade 函数中**纯值构造**的那些：有 facade 身份，但不产生站点、不过 host。目前只有
 * `model`（docs/dynamic-workflow/authoring.md「Choosing a model per subagent」）。
 *
 * `ModelRef` 只活在类型系统里：运行期它就是模型名字符串本身，所以 lowering 把 `model("x")`
 * 抹成实参 `"x"`，沙箱里既没有 `__host.model`，也没有 journal 行。与 `phase` 分列的理由同
 * {@link MARKER_FUNCTIONS}：它不产生站点，混进产生站点的清单会让 facade-misuse 的 pass 2 拒绝
 * 每一次合法调用；它仍是 facade 函数声明，所以别名逃逸（`const m = model`）照旧被 pass 1 拒绝，
 * lowering 因此可以放心按节点身份抹除。
 */
const VALUE_FUNCTIONS = ["model"] as const;

/** 顶层纯值 facade 函数名。由 {@link VALUE_FUNCTIONS} 推导。 */
type ValueFunction = (typeof VALUE_FUNCTIONS)[number];

/** 某 facade symbol 解析到的纯值顶层函数（按声明判定：容器必须缺席），否则 undefined。 */
export function valueFunctionOfSymbol(symbol: ts.Symbol | undefined): ValueFunction | undefined {
  const member = facadeMemberOf(symbol);
  if (member === undefined || member.container !== undefined) return undefined;
  return VALUE_FUNCTIONS.find((name) => name === member.member);
}

/**
 * 全部产生站点的 facade 成员名（world-read 成员 + `ask`）。**裸名字**清单，只可用于
 * "先按名字取候选、再按声明验身份"的两段式判定——不可单独作为身份依据（见本模块顶部）。
 *
 * `git.log` 落地后这个集合里**含有 `"log"`**，而顶层 `log()` 不产生站点。这不是矛盾，
 * 而是这份清单为什么只能当候选键的证明：身份必须由 (容器, 成员) 或声明解析给出，
 * 名字本身答不了。唯一还被依赖的性质是**没有两个 facade 容器声明同名成员**——
 * 集合不带容器，重名会让由它反查出的那个名字变得二义（facade-misuse 的诊断文案会引它）。
 */
export const SITE_MEMBER_NAMES: ReadonlySet<string> = new Set<string>([
  ASK_MEMBER.member,
  ...WORLD_READ_REGISTRY.map((row) => row.member),
  ...ARTIFACT_REGISTRY.map((row) => row.member),
]);

/**
 * 注册表查询：(容器, 成员) → op。容器为 undefined（顶层函数）时永不命中——world-read
 * 一律挂在 facade 容器对象上。
 */
export function worldReadOp(
  container: string | undefined,
  member: string,
): WorldReadOp | undefined {
  if (container === undefined) return undefined;
  return WORLD_READ_REGISTRY.find((row) => row.container === container && row.member === member)
    ?.op;
}

/**
 * (容器, 成员) 是否为产生站点的 facade 调用（world-read、产物、`Agent.ask`、或顶层
 * `agent`/`report`）。
 *
 * 产物成员在这里，与 `report` 同一条理由：它们有 journal 键（`artifact#N` × ordinal），
 * 而一次没有站点的发布就是一行没有键的 journal 记录——那正是 facade-siting 规则要防的。
 */
export function isSiteProducing(container: string | undefined, member: string): boolean {
  if (container === undefined) return SITE_PRODUCING_FUNCTIONS.some((name) => name === member);
  if (container === ASK_MEMBER.container && member === ASK_MEMBER.member) return true;
  if (artifactRow(container, member) !== undefined) return true;
  return worldReadOp(container, member) !== undefined;
}

/**
 * 一个 facade 声明所属的**容器名**：`declare const files: { glob(...) }` 的 `glob` → `"files"`，
 * `declare interface Agent { ask(...) }` 的 `ask` → `"Agent"`，顶层 `declare function agent()` →
 * undefined（无容器）。
 *
 * 实现：成员的声明是类型字面量/接口体里的一个 method/property signature，据此向上走到
 * VariableDeclaration（const 容器）或 InterfaceDeclaration / TypeAliasDeclaration（命名类型容器）
 * 取其名字。只认落在 facade `.d.ts` 里的声明——脚本自定义的同名成员一律 undefined。
 */
export function facadeContainerOf(declaration: ts.Node | undefined): string | undefined {
  if (declaration === undefined) return undefined;
  if (declaration.getSourceFile().fileName !== FACADE_FILE_NAME) return undefined;
  for (let node: ts.Node | undefined = declaration.parent; node !== undefined; node = node.parent) {
    if (ts.isVariableDeclaration(node)) {
      return ts.isIdentifier(node.name) ? node.name.text : undefined;
    }
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return node.name.text;
    if (ts.isSourceFile(node)) return undefined;
  }
  return undefined;
}

/**
 * 一个 facade symbol 的 (容器, 成员) 身份。symbol 的任一声明落在 facade `.d.ts` 内即算命中；
 * 容器由该声明向上解析（顶层 facade 函数无容器）。非 facade symbol → undefined。
 */
export function facadeMemberOf(
  symbol: ts.Symbol | undefined,
): { container: string | undefined; member: string } | undefined {
  const declaration = symbol?.declarations?.find(
    (decl) => decl.getSourceFile().fileName === FACADE_FILE_NAME,
  );
  if (declaration === undefined || symbol === undefined) return undefined;
  return { container: facadeContainerOf(declaration), member: symbol.name };
}

/** 某 facade symbol 解析到的 world-read op（按声明容器判定），非 world-read 则 undefined。 */
export function worldReadOpOfSymbol(symbol: ts.Symbol | undefined): WorldReadOp | undefined {
  const member = facadeMemberOf(symbol);
  if (member === undefined) return undefined;
  return worldReadOp(member.container, member.member);
}
