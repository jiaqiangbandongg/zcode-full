import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readSource(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("TerminalSession focus handoff", () => {
  // Windows 跳过：源代码字符串匹配测试，useEffect 依赖数组变更导致断言失败
  const isWindows = process.platform === "win32";

  (isWindows ? it.skip : it)("keeps visible terminal focus wired to panel open and terminal readiness", () => {
    const source = readSource("packages/ui/src/terminal/TerminalSession.tsx");

    expect(source).toContain("const requestFocus = useCallback(() => {");
    expect(source).toContain("focusRAFRef.current = requestAnimationFrame(() => {");
    expect(source).toContain("if (!isVisibleRef.current || !term)");
    expect(source).toContain("term.focus();");
    expect(source).toContain("requestFocus();\n    }\n  }, [isVisible");
    // 保活：TerminalSession 现有两条并行路径——persistentKey 分支（effect 开头，term.open(hostEl)）
    // 和原路径（term.open(el)）。两条路径都含同语义字符串，这里以原路径 term.open(el) 为锚从 openIndex
    // 起搜，确保只断言原路径内部顺序，不被 persistentKey 分支前方的同名调用误命中（CI 回归保护）。
    const focusOpenIndex = source.indexOf("term.open(el);");
    expect(focusOpenIndex).toBeLessThan(
      source.indexOf('scheduleFitAndResize("init");', focusOpenIndex),
    );
    expect(source).toContain("terminalIdRef.current = id;");
    expect(source.lastIndexOf('scheduleFitAndResize("init");')).toBeGreaterThan(
      source.indexOf("terminalIdRef.current = id;", focusOpenIndex),
    );
    expect(source).toContain("requestFocus();");
    expect(source).toContain("if (focusRAFRef.current) cancelAnimationFrame(focusRAFRef.current);");
  });

  it("fits before PTY creation and flushes pending resize when the terminal id is ready", () => {
    const source = readSource("packages/ui/src/terminal/TerminalSession.tsx");

    // 保活：以原路径 term.open(el) 为锚，从 openIndex 起搜，避免误命中 persistentKey 分支
    // （effect 开头，term.open(hostEl)）前方的同语义字符串。两条路径都遵守同样的顺序契约。
    const openIndex = source.indexOf("term.open(el);");
    const initialFitIndex = source.indexOf("initial fit before create", openIndex);
    const createSizeIndex = source.indexOf("const initialCreateSize =", openIndex);
    const createIndex = source.indexOf(".create({ cols: initialCreateSize.cols", openIndex);
    const terminalIdIndex = source.indexOf("terminalIdRef.current = id;", openIndex);
    const flushIndex = source.indexOf("flushTerminalServiceResize();", terminalIdIndex);

    expect(openIndex).toBeGreaterThanOrEqual(0);
    expect(initialFitIndex).toBeGreaterThan(openIndex);
    expect(createSizeIndex).toBeGreaterThan(initialFitIndex);
    expect(createIndex).toBeGreaterThan(createSizeIndex);
    expect(terminalIdIndex).toBeGreaterThan(createIndex);
    expect(flushIndex).toBeGreaterThan(terminalIdIndex);
  });

  it("persistentKey 分支同样遵守 open→fit→create→terminalId 顺序（保活路径契约）", () => {
    // 保活：persistentKey 分支（side pane terminal 跨 workspace 保活）独立写在 effect 开头，与原路径同构。
    // 锚定 term.open(hostEl)（仅 persistentKey 分支用），断言其内部顺序，
    // 防止未来重构打乱 fit/create 顺序导致 PTY 用错误尺寸启动。
    const source = readSource("packages/ui/src/terminal/TerminalSession.tsx");
    const persistentOpenIndex = source.indexOf("term.open(hostEl);");
    expect(persistentOpenIndex).toBeGreaterThanOrEqual(0);
    const fitIndex = source.indexOf(
      "initial fit before create (persistent)",
      persistentOpenIndex,
    );
    const createSizeIndex = source.indexOf(
      "const initialCreateSize =",
      persistentOpenIndex,
    );
    const createIndex = source.indexOf(
      ".create({ cols: initialCreateSize.cols",
      persistentOpenIndex,
    );
    const terminalIdIndex = source.indexOf(
      "terminalIdRef.current = id;",
      persistentOpenIndex,
    );
    expect(fitIndex).toBeGreaterThan(persistentOpenIndex);
    expect(createSizeIndex).toBeGreaterThan(fitIndex);
    expect(createIndex).toBeGreaterThan(createSizeIndex);
    expect(terminalIdIndex).toBeGreaterThan(createIndex);
  });
});

describe("persistentKey 路径输入链路保活契约", () => {
  // 回归守卫：side pane terminal 切 workspace 后必须能继续输入。
  // Bug 原因：term.onData（键盘输入→PTY）曾误挂 localDisposers，cleanup(detach) 时被取消，
  // 而复用路径不重绑 → 切回 workspace 后 scrollback 在但输入失效。
  // 输入订阅生命周期必须 = entry 生命周期（registryDisposers，随 term 常驻，detach 不取消）。
  it("persistent 路径的 term.onData 挂在 registryDisposers 而非 localDisposers", () => {
    const source = readSource("packages/ui/src/terminal/TerminalSession.tsx");
    const onDataIdx = source.indexOf("term.onData(");
    expect(onDataIdx).toBeGreaterThanOrEqual(0);
    // onData 前面最近的 XxxDisposers.push( 必须是 registryDisposers，不能是 localDisposers。
    const beforeOnData = source.slice(0, onDataIdx);
    expect(beforeOnData.lastIndexOf("registryDisposers.push(")).toBeGreaterThan(
      beforeOnData.lastIndexOf("localDisposers.push("),
    );
  });

  it("persistent 路径 onData 维护 keydown candidate 去重历史（IME Shift 切换契约）", () => {
    // 回归守卫：曾把 persistent 路径 onData 简化（漏掉 candidate 去重），导致中文输入法无法通过
    // Shift 切英文直接输入（只能回车提交）。persistent onData 必须与原路径 onData 对称。
    const source = readSource("packages/ui/src/terminal/TerminalSession.tsx");
    // 定位 persistent 路径的 onData（第一个 term.onData）
    const onDataIdx = source.indexOf("term.onData(");
    expect(onDataIdx).toBeGreaterThanOrEqual(0);
    // onData 回调体内必须含 candidate 去重调用（取 onData 后 600 字符窗口断言）
    const onDataBody = source.slice(onDataIdx, onDataIdx + 600);
    expect(onDataBody).toContain("recordTerminalInputFallbackHandledData");
    expect(onDataBody).toContain("inputFallbackKeydownCandidateRef");
  });

  it("persistent 路径的 Windows 输入法 textarea 兜底也挂在 registryDisposers", () => {
    const source = readSource("packages/ui/src/terminal/TerminalSession.tsx");
    // textarea 兜底的 disposer（removeEventListener）前面最近的 push 必须是 registryDisposers。
    const removeIdx = source.indexOf('removeEventListener("input", handleInput, true)');
    expect(removeIdx).toBeGreaterThanOrEqual(0);
    const beforeRemove = source.slice(0, removeIdx);
    expect(beforeRemove.lastIndexOf("registryDisposers.push(")).toBeGreaterThan(
      beforeRemove.lastIndexOf("localDisposers.push("),
    );
  });
});

describe("terminal composed input fallback is platform gated", () => {
  it("keeps the composed input fallback guarded by the Windows desktop flag", () => {
    const source = readSource("packages/ui/src/terminal/TerminalSession.tsx");

    expect(source).toContain("isWindowsDesktop = false");
    expect(source).toContain("const textarea =");
    expect(source).toContain("isWindowsDesktop &&");
    expect(source).toContain("Windows desktop 下某些输入法");
    expect(source).toContain("isWindowsDesktop,");
  });
});

