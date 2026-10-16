import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readSource(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

/**
 * side pane terminal persistent 路径 PTY 创建失败的回收契约（CR-01 回归守卫）。
 *
 * Bug 原因（CR-01）：
 *   persistent 路径先在 TerminalSession.tsx 第 541 行把 entry（terminalId 占位 ""）
 *   register 进 registry，再异步调用 terminalService.create()。当 create() reject 时，
 *   catch 仅 term.write 错误信息，没有 sidePaneTerminalSessionRegistry.release(persistentKey)。
 *   此时 entry 的 terminalId 仍为空，但 registry 已认为该 session 存在。
 *   后果：用户切 workspace 或组件重挂后，复用快路径（line 341）命中这个僵尸 entry，
 *   直接复用已启动失败的 xterm，且永不重新调用 terminalService.create()，
 *   该终端永久无法连接 PTY。
 *
 * 修复：catch 中释放僵尸 entry；但必须先做 ownership 校验，避免「create reject 触发前，
 *   组件已卸载并重挂、registry 已被新 entry 覆盖」时误删新 entry（新创建的 term）。
 *   cleanup（line 726）已用闭包 entry 判断处理「PTY 未就绪即卸载」的半成品回收；
 *   catch 这里补的是「失败但组件尚未卸载」的回收。
 */
describe("side pane terminal persistent PTY 创建失败回收契约", () => {
  it("persistent 路径 PTY create 失败时必须释放 registry 中的占位 entry", () => {
    const source = readSource("packages/ui/src/terminal/TerminalSession.tsx");

    // 定位 persistent create 失败的 catch 块，并限定到 catch 块内（到闭合 });）。
    // 不能往后取太长：cleanup（line 726-727）也调 release，会被误判命中。
    const catchIdx = source.indexOf("persistent create failed");
    expect(catchIdx).toBeGreaterThan(-1);
    const catchEnd = source.indexOf("});", catchIdx);
    expect(catchEnd).toBeGreaterThan(catchIdx);
    const block = source.slice(catchIdx, catchEnd);

    // 回归守卫：PTY create 失败必须 release 占位 entry，否则 terminalId="" 的僵尸 entry
    // 留在 registry，重挂命中复用快路径永不重试 create（CR-01）。
    expect(block).toContain("sidePaneTerminalSessionRegistry.release(persistentKey)");
  });

  it("release 前必须校验 registry 当前 entry 仍属于本次创建（避免误删重挂后的新 entry）", () => {
    const source = readSource("packages/ui/src/terminal/TerminalSession.tsx");

    const catchIdx = source.indexOf("persistent create failed");
    expect(catchIdx).toBeGreaterThan(-1);
    const catchEnd = source.indexOf("});", catchIdx);
    expect(catchEnd).toBeGreaterThan(catchIdx);
    const block = source.slice(catchIdx, catchEnd);

    // ownership 校验：只有 registry 当前 entry === 本次闭包 entry 时才 release。
    // 防止「create reject 前，组件已卸载并重挂、registry 已被新 entry 覆盖」时误删新 entry。
    expect(block).toContain("sidePaneTerminalSessionRegistry.get(persistentKey)");
    expect(block).toContain("=== entry");
  });
});
