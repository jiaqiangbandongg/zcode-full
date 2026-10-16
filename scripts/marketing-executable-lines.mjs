import ts from "typescript";
import { createInstrumenter } from "istanbul-lib-instrument";
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";

/** 先消除 TS 语法再插桩，避免直接解析 TS 时漏掉运行时 enum。 */
export function executableSourceLines(source, file) {
  const compiled = ts.transpileModule(source, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.Preserve,
      sourceMap: true,
      inlineSources: true,
    },
  });
  const errors = (compiled.diagnostics ?? []).filter(
    (d) => d.category === ts.DiagnosticCategory.Error,
  );
  if (errors.length || !compiled.sourceMapText)
    return {
      status: "unknown",
      reason: "typescript-transform",
      diagnostics: errors.map((d) => d.code),
    };
  try {
    const instrumenter = createInstrumenter({ parserPlugins: ["jsx"], esModules: true });
    instrumenter.instrumentSync(compiled.outputText, file);
    const map = new TraceMap(JSON.parse(compiled.sourceMapText));
    const lines = new Set();
    let unmappedStatements = 0;
    for (const statement of Object.values(instrumenter.lastFileCoverage().statementMap)) {
      const original = originalPositionFor(map, {
        line: statement.start.line,
        column: statement.start.column,
      });
      if (original.line === null) unmappedStatements++;
      else lines.add(original.line);
    }
    return { status: "mapped", lines: [...lines].sort((a, b) => a - b), unmappedStatements };
  } catch (error) {
    return { status: "unknown", reason: "instrumentation", message: error.message };
  }
}
