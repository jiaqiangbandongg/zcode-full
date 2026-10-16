/**
 * 解析"怎么调用 pnpm"这一个决策，独立成模块只为可测：bump 脚本本体是 top-level await，
 * import 它就会真的执行一次 bump，没法在单测里覆盖这段逻辑。
 */

/**
 * @param {{ npmExecpath?: string | undefined, platform: string }} input
 * @returns {{ command: string, args: string[], options: { shell?: true } }}
 */
export function resolvePnpmInvocation(input) {
  const { npmExecpath, platform } = input;
  const args = ["install", "--prefer-offline"];
  // 首选让当前 Node 直接跑 pnpm 的 JS 入口：不经 shell、不碰 `.cmd`，三平台同一条码路。
  // pnpm 运行 package script 时会注入 npm_execpath。
  const entry = typeof npmExecpath === "string" ? npmExecpath.trim() : "";
  if (entry) {
    return { command: process.execPath, args: [entry, ...args], options: {} };
  }
  // 回落。Windows 上 pnpm 是 `pnpm.cmd`：execFile 不走 shell 时不补 PATHEXT（ENOENT），
  // 而 Node 自 18.20/20.12 起（CVE-2024-27980）又禁止不带 shell spawn `.cmd`（EINVAL）。
  // 两条都堵死，所以这里只能借 shell；参数是硬编码字面量，没有拼接也没有外部输入。
  if (platform === "win32") {
    return { command: "pnpm", args, options: { shell: true } };
  }
  return { command: "pnpm", args, options: {} };
}
