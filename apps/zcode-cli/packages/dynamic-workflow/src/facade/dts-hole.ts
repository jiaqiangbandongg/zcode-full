/**
 * facade 的 hole 段（docs/dynamic-workflow/authoring.md「Holes: `hole<T>()`」）：类型化的留白。
 *
 * 自成一个模块只因 dts.ts 顶在 max-lines 上限（模板字面量里的散文按代码行计）；契约不变：
 * 这一段由 dts.ts 拼进 `FACADE_DTS`——**只进完整 facade，不进 snippet facade**（片段没有 run，
 * 也就没有可等主代理补全的东西）。tests/facade-dts.test.ts 以 sha256 钉住拼接结果。段以单个
 * 换行开头结尾，与其余段同规。
 */

/**
 * 留白原语：`hole<T>(name, prompt?, body?)`。三个重载对应三种写法——开放的留白（名字 + 可选
 * 提示）、已补全的留白（名字 + 函数体）、两者都有。运行期它是一次 Boundary A 调用
 * （`__host.hole`），站点 id 是名字键 `hole#<hash>`（analysis/hole-id.ts）；函数体在 cell 内**原地**求值，见 execution-engine.md
 * 「The vm cell」。编译期规则全在 9012（analysis/hole-sites.ts）。
 */
export const FACADE_HOLE_SEGMENT = String.raw`
/**
 * A typed gap: code you write later, once an earlier step's findings are in. When the run
 * reaches an unfilled hole, that branch waits while you write the body (FillWorkflowHole);
 * the rest of the run keeps going. prompt is the message you will receive, so interpolate
 * the values the decision needs. The body runs in the hole's place, sees the bindings
 * declared before it, and returns the hole's value. The filled form passes the body last.
 */
declare function hole<T>(name: string, prompt?: string): Promise<T>;
declare function hole<T>(name: string, body: () => Promise<T>): Promise<T>;
declare function hole<T>(name: string, prompt: string, body: () => Promise<T>): Promise<T>;
`;
