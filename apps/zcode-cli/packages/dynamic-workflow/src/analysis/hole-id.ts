/**
 * 留白站点 id（docs/analysis.md「Sites」的 Hole sites 段）：`hole#<8 位十六进制>`，键是留白的
 * **名字**（FNV-1a 32 位，按 Unicode 码点，名字先 trim），与它嵌套在哪一层无关。
 *
 * 为什么不是位置计数器：补全在脚本中间插入代码，任何按位置编号的方案都会让插入点之后的留白
 * 改号，而 journal 键、ask spec、站点阶段表都靠 id 在补全后幸存。为什么不再是外层 id 前缀
 * （2026-09-28 之前的 `hole#1/hole#1/ask#1`）：每嵌套一层长 7 个字符，接龙式补全（每一步在
 * 结尾再留一个留白）八九步就顶到协议里 64 字符的 id 上界，而这条上界是对的——协议载荷必须
 * 有界。名字在整个有效脚本里唯一（9012），所以名字键既在补全前后稳定，又不随深度增长。两个
 * 不同名字撞到同一哈希由 9012 报出（32 位、一个脚本至多几十个留白，概率约 1e-7），从不猜。
 *
 * 函数体里的站点仍带 `<holeId>/` 前缀（`hole#a91f3c07/ask#1`），但只带**一层**：体内再留的
 * 留白自己又是 `hole#<hash>`，它体内的站点带它自己的前缀。嵌套关系不再写在 id 里，而是站点
 * 表上的 `fill` 字段（HoleSite.fill：包着它的那个留白）。
 */

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** 留白 id 里十六进制的位数；协议侧的 id 上界（64）与它无关，这里只是让 id 短而固定。 */
export const HOLE_ID_HEX_LENGTH = 8;

/** 留白站点 id 的形状。UI 与稳定性复核靠它认出「这个 id 是一个留白」。 */
export const HOLE_SITE_ID_PATTERN = /^hole#[0-9a-f]{8}$/u;

/** 从留白的名字铸站点 id。名字先 trim（唯一性也按 trim 后比较）。 */
export function holeSiteId(name: string): string {
  let hash = FNV_OFFSET;
  for (const char of name.trim()) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return `hole#${hash.toString(16).padStart(HOLE_ID_HEX_LENGTH, "0")}`;
}

export function isHoleSiteId(id: string): boolean {
  return HOLE_SITE_ID_PATTERN.test(id);
}

/**
 * 一个站点 id 所属的留白：`hole#x/ask#1` → `hole#x`；一个留白自己的 id 或体外的 id → undefined。
 * 只看一层前缀（id 里只有一层）；留白自己属于哪个留白要问站点表的 `fill`。
 */
export function holePrefixOf(siteId: string): string | undefined {
  const cut = siteId.indexOf("/");
  return cut < 0 ? undefined : siteId.slice(0, cut);
}
