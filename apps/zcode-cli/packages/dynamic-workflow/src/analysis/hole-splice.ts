import { SCRIPT_PRELUDE_LENGTH, type ScriptLoc } from "../compiler/compile.js";
import { holePrefixOf } from "./hole-id.js";
import type { SiteTable } from "./sites.js";

/**
 * 补全服务的两件纯文本工具（execution-engine.md「The fill service's checks」）：把函数体拼进
 * 留白调用、以及补全前后站点表的稳定性复核。两者都不碰引擎与 journal，run service 按序调用。
 */

/** 拼接结果：新文本、第一行插入行的脚本行号（1-based）与插入的行数。 */
export interface SplicedHoleBody {
  text: string;
  insertedAtLine: number;
  insertedLines: number;
}

/** 函数体相对调用缩进再多缩的空格数。 */
const BODY_EXTRA_INDENT = 2;

/**
 * 把 `body` 作为最后一个实参拼进留白调用：紧接在**最后一个实参的末尾**插入 `, async () => {\n<body>\n}`，
 * 函数体每行按调用所在行的缩进再加两格，右花括号取调用的缩进。返回 `undefined` 当留白不在表里
 * 或已经有函数体——补全一个已补全的留白不是拼接能表达的事。
 *
 * 插入点是最后一个实参的末尾而不是右括号之前：2026-09-28 首次实测里主代理按 prettier 的习惯写了
 * `hole<T>(\n  "名",\n  \`提示\`,\n);`——提示后面带一个尾随逗号——在右括号前插入就得到 `, , async`，
 * 四条语法错误全锚在草稿上，而草稿并没有错。接在实参末尾之后，原来的尾随逗号与换行留在函数体
 * 之后（`}, \n)`），仍是合法调用；实参与右括号之间的注释同样原样保留。
 *
 * `insertedAtLine` 是第一条函数体行在新脚本里的行号（`, async () => {` 留在最后一个实参结束的那一
 * 行上），`insertedLines` 是新增的换行数（函数体行数 + 右花括号那一行）：诊断按这两个数分到「补全
 * 文件内」与「草稿内」。
 */
export function spliceHoleBody(
  scriptText: string,
  table: SiteTable,
  holeSiteId: string,
  body: string,
): SplicedHoleBody | undefined {
  const site = table.holes.find((hole) => hole.id === holeSiteId);
  if (site === undefined || site.body !== undefined) return undefined;
  const lastArg = site.call.arguments[site.call.arguments.length - 1];
  if (lastArg === undefined) return undefined;
  const insertAt = lastArg.getEnd() - SCRIPT_PRELUDE_LENGTH;
  const lineStart = scriptText.lastIndexOf("\n", site.call.getStart() - SCRIPT_PRELUDE_LENGTH) + 1;
  const indent = /^[ \t]*/.exec(scriptText.slice(lineStart))?.[0] ?? "";
  const bodyIndent = `${indent}${" ".repeat(BODY_EXTRA_INDENT)}`;
  const bodyLines = body.replace(/\r?\n$/, "").split(/\r?\n/);
  const inserted = [
    ", async () => {",
    ...bodyLines.map((line) => (line.trim() === "" ? "" : `${bodyIndent}${line}`)),
    `${indent}}`,
  ];
  const before = scriptText.slice(0, insertAt);
  const text = `${before}${inserted.join("\n")}${scriptText.slice(insertAt)}`;
  const callLine = before.split("\n").length; // 最后一个实参结束的那一行（1-based）
  return { insertedAtLine: callLine + 1, insertedLines: inserted.length - 1, text };
}

/** 稳定性复核的结果：通过，或一句说明是哪个 id 在哪儿变了。 */
export type SiteStability = { ok: true } | { ok: false; detail: string };

interface LocatedSite {
  id: string;
  loc: ScriptLoc;
}

function everySite(table: SiteTable): LocatedSite[] {
  return [
    ...table.asks,
    ...table.actors,
    ...table.worldReads,
    ...table.joins,
    ...table.reports,
    ...table.artifacts,
    ...table.holes,
  ].map((site) => ({ id: site.id, loc: site.loc }));
}

/**
 * 补全前后站点表的稳定性（docs/analysis.md「Sites」的站点 id 稳定性规则，延伸到「加函数体」）：
 * `before` 的每个 id（全部种类）都在 `after` 里，位置不变或——落在插入点之后时——行号整体后移
 * `insertedLines`；`after` 里 `before` 没有的每个 id 都是这次补全写下的：带 `<holeSiteId>/`
 * 前缀，或者是函数体里新留的留白（`fill` 链通到 `holeSiteId`）及其体内的站点。哪条不成立都是
 * 宿主的错（分析器的编号规则被打破了），run 不能拿到它接不上的 id。
 *
 * 与插入点同一行、插入点之后的站点（`await hole(...); agent("a")` 写在一行）行号后移但列号
 * 变了：那一行只比对行号。
 */
export function checkSiteStability(
  before: SiteTable,
  after: SiteTable,
  holeSiteId: string,
  insertedAtLine: number,
  insertedLines: number,
): SiteStability {
  const afterById = new Map(everySite(after).map((site) => [site.id, site.loc]));
  const parenLine = insertedAtLine - 1;
  for (const site of everySite(before)) {
    const moved = afterById.get(site.id);
    if (moved === undefined)
      return { detail: `site ${site.id} vanished after the fill`, ok: false };
    const shifted = site.loc.line >= parenLine;
    const expectedLine = shifted ? site.loc.line + insertedLines : site.loc.line;
    const sameLine =
      moved.line === expectedLine || (site.loc.line === parenLine && moved.line === site.loc.line);
    const sameColumn = site.loc.line === parenLine || moved.column === site.loc.column;
    if (!sameLine || !sameColumn) {
      return {
        detail:
          `site ${site.id} moved from ${site.loc.line}:${site.loc.column} to ${moved.line}:${moved.column}` +
          ` (expected line ${expectedLine})`,
        ok: false,
      };
    }
  }
  const known = new Set(everySite(before).map((site) => site.id));
  // 这次补全写下的留白：`fill` 链一路通到被补全的留白（体内再留的、以及体内内联填好的）。
  const fillOf = new Map(after.holes.map((hole) => [hole.id, hole.fill]));
  const writtenByFill = (holeId: string): boolean => {
    for (let cur: string | undefined = holeId; cur !== undefined; cur = fillOf.get(cur)) {
      if (cur === holeSiteId) return true;
    }
    return false;
  };
  for (const site of everySite(after)) {
    if (known.has(site.id)) continue;
    const owner = holePrefixOf(site.id) ?? site.id;
    if (!writtenByFill(owner)) {
      return { detail: `site ${site.id} appeared outside the fill of ${holeSiteId}`, ok: false };
    }
  }
  return { ok: true };
}
