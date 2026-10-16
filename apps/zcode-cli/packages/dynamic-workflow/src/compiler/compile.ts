import ts from "typescript";
import { FACADE_DTS, FACADE_FILE_NAME } from "../facade/dts.js";
import { TS_LIBS } from "./libs.generated.js";

/** One diagnostic, positioned in the author's script (1-based line/column). */
export interface CompileDiagnostic {
  code: number;
  column: number;
  line: number;
  message: string;
}

export interface CompileResult {
  diagnostics: CompileDiagnostic[];
  ok: boolean;
}

export const SCRIPT_FILE_NAME = "workflow-script.ts";

// Name of the wrapper function the script body is spliced into (see SCRIPT_PRELUDE).
// The site walk locates this declaration to bound its traversal to the authored
// body and to tell top-level `return`s apart from ones in nested functions.
export const WORKFLOW_FUNCTION_NAME = "__workflowScript__";

// The script is wrapped in an async function before typechecking, mirroring the
// runtime execution shape (AsyncFunction body): top-level await and a final
// `return <artifact>` are both legal, and the file stays a non-module global
// script so the facade declarations are in scope without imports.
// No return-type annotation: an annotated Promise<unknown> would demand a return
// statement (TS2355), but scripts may legitimately end without one.
const SCRIPT_PRELUDE = `async function ${WORKFLOW_FUNCTION_NAME}() {\n`;
/**
 * 包装前缀的长度：wrapped 源码里的位置减去它就是作者原文里的偏移。留白补全的拼接
 * （analysis/hole-splice.ts）要按站点表里的节点位置在原文上插入文本，走的正是这条换算。
 */
export const SCRIPT_PRELUDE_LENGTH = SCRIPT_PRELUDE.length;
const SCRIPT_EPILOGUE = "\n}\nexport {};\n";
const PRELUDE_LINES = 1;

const COMPILER_OPTIONS: ts.CompilerOptions = {
  allowJs: false,
  lib: ["lib.es2022.d.ts"],
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  noEmit: true,
  skipLibCheck: true,
  // `strict` on, `noUncheckedIndexedAccess` deliberately OFF. Models write TS as
  // if the flag were off — training corpora almost universally have it off — so
  // with it on, TS2532/TS18048 on `items[i]` was the single largest source of
  // compile failures (96% of the undefined-family diagnostics in local runs),
  // almost all on indexes whose bounds the surrounding logic already proved.
  // `strictNullChecks` stays: `.find()` / `match()` / optional properties are
  // real hazards and their messages name the cause.
  strict: true,
  target: ts.ScriptTarget.ES2022,
  // No ambient @types: the script sees ES2022 + the facade and nothing else.
  // `process`, `fetch`, `require` etc. fail typechecking — the purity contract
  // starts at compile time.
  types: [],
};

/** A prelude-adjusted, 1-based location in the author's script coordinates. */
export interface ScriptLoc {
  line: number;
  column: number;
}

/**
 * The typed program plus the two things every downstream analysis needs: the
 * wrapped script's source file (to walk) and a mapper from raw scanner positions
 * back into the author's 1-based, prelude-stripped coordinates.
 */
export interface WorkflowProgram {
  program: ts.Program;
  scriptFile: ts.SourceFile;
  toScriptLoc(pos: number): ScriptLoc;
}

/**
 * {@link createWorkflowProgram} 的选项。`facadeDts` 允许注入一份**替代的 facade 文本**
 * （snippet eval 的 scratch facade）；它永远以
 * {@link FACADE_FILE_NAME} 为文件名进虚拟 host——facade 身份在 registry / sites /
 * facade-misuse / lowering 五处按声明文件名判定，换名字会让站点收集静默变空。
 */
export interface CreateWorkflowProgramOptions {
  facadeDts?: string;
}

/**
 * Build the typed program for a workflow script: the wrapped script + facade
 * `.d.ts` + embedded stdlib, compiled in the virtual host. This is the shared
 * substrate — diagnostics, schema synthesis and site-graph extraction all hang
 * off the one Program and checker built here.
 */
export function createWorkflowProgram(
  scriptText: string,
  options?: CreateWorkflowProgramOptions,
): WorkflowProgram {
  const wrapped = `${SCRIPT_PRELUDE}${scriptText}${SCRIPT_EPILOGUE}`;
  const host = createVirtualHost(wrapped, options?.facadeDts ?? FACADE_DTS);
  const program = ts.createProgram({
    host,
    options: COMPILER_OPTIONS,
    rootNames: [SCRIPT_FILE_NAME, FACADE_FILE_NAME],
  });
  const scriptFile = program.getSourceFile(SCRIPT_FILE_NAME);
  if (scriptFile === undefined) {
    throw new Error("workflow script source file missing from program");
  }
  const toScriptLoc = (pos: number): ScriptLoc => {
    const { character, line } = scriptFile.getLineAndCharacterOfPosition(pos);
    return { column: character + 1, line: Math.max(1, line - PRELUDE_LINES + 1) };
  };
  return { program, scriptFile, toScriptLoc };
}

/** Collect and script-position the program's syntactic + semantic diagnostics. */
export function collectDiagnostics(program: ts.Program): CompileDiagnostic[] {
  return [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()].map(
    toCompileDiagnostic,
  );
}

/**
 * Typecheck a workflow script against the facade in a fully virtual compiler host.
 * Scaffold scope: diagnostics only. Schema synthesis, site-graph extraction and
 * dependency inference build on the same Program in later steps.
 */
export function compileWorkflowScript(scriptText: string): CompileResult {
  const { program } = createWorkflowProgram(scriptText);
  const diagnostics = collectDiagnostics(program);
  return { diagnostics, ok: diagnostics.length === 0 };
}

// Fully virtual compiler host: every file the program can see — the wrapped
// script, the facade, and the embedded TS stdlib closure (TS_LIBS) — is served
// from an in-memory Map. Nothing touches disk, so the bundled/SEA CLI (no
// node_modules) behaves identically to dev: a missing lib fails package tests
// too, instead of only breaking in the bundle.
function createVirtualHost(wrappedScript: string, facadeDts: string): ts.CompilerHost {
  const virtualFiles = new Map<string, string>([
    [SCRIPT_FILE_NAME, wrappedScript],
    [FACADE_FILE_NAME, facadeDts],
    ...Object.entries(TS_LIBS),
  ]);
  const sourceFileCache = new Map<string, ts.SourceFile>();

  return {
    getSourceFile: (fileName, languageVersionOrOptions) => {
      const cached = sourceFileCache.get(fileName);
      if (cached !== undefined) return cached;
      const text = virtualFiles.get(fileName);
      if (text === undefined) return undefined;
      const sourceFile = ts.createSourceFile(fileName, text, languageVersionOrOptions, true);
      sourceFileCache.set(fileName, sourceFile);
      return sourceFile;
    },
    getDefaultLibFileName: (options) => ts.getDefaultLibFileName(options),
    writeFile: () => {
      throw new Error("workflow compile is noEmit; nothing may write output");
    },
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (fileName) => virtualFiles.has(fileName),
    readFile: (fileName) => virtualFiles.get(fileName),
  };
}

// TS1184 ("Modifiers cannot appear here.") is what a script-top-level `declare`
// or `export` compiles to, because the body is spliced into SCRIPT_PRELUDE's
// function — ambient declarations and exports are both illegal there. The raw
// text never names the offending modifier, so the model's self-repair loop can
// only guess; these rewrites name it and give the fix. Keyed on the exact
// modifier span, so any other misplaced modifier keeps the compiler's wording.
const AMBIENT_MODIFIER_MESSAGES = new Map<string, string>([
  [
    "declare",
    "The `declare` modifier is not allowed in a workflow script: the script is compiled inside a function body, where ambient declarations are illegal. Remove `declare` and write a plain declaration (e.g. `interface Foo { ... }`).",
  ],
  [
    "export",
    "`export` is not allowed in a workflow script: the script is compiled inside a function body. Remove `export` — the workflow's output is its final `return` value.",
  ],
]);

const MISPLACED_MODIFIER_CODE = 1184;

function toCompileDiagnostic(diagnostic: ts.Diagnostic): CompileDiagnostic {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  if (diagnostic.file === undefined || diagnostic.start === undefined) {
    return { code: diagnostic.code, column: 1, line: 1, message };
  }
  const { character, line } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  const scriptLine = diagnostic.file.fileName === SCRIPT_FILE_NAME ? line - PRELUDE_LINES : line;
  return {
    code: diagnostic.code,
    column: character + 1,
    line: Math.max(1, scriptLine + 1),
    message: rewriteAmbientModifierMessage(diagnostic) ?? message,
  };
}

/** The actionable replacement for a script-level `declare` / `export`, if this is one. */
function rewriteAmbientModifierMessage(diagnostic: ts.Diagnostic): string | undefined {
  if (
    diagnostic.code !== MISPLACED_MODIFIER_CODE ||
    diagnostic.file?.fileName !== SCRIPT_FILE_NAME ||
    diagnostic.start === undefined ||
    diagnostic.length === undefined
  ) {
    return undefined;
  }
  const span = diagnostic.file.text.slice(diagnostic.start, diagnostic.start + diagnostic.length);
  return AMBIENT_MODIFIER_MESSAGES.get(span);
}
