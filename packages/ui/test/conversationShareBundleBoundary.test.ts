import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// SG-01 静态守卫：公开匿名分享页（packages/web/src/share）直接引用的只读时间线必须物理
// 排除 open-with 子树（OpenSplitButton → platform hooks、tab store、workspace-file-tree、
// editorPreference 等 Desktop 专属依赖）。此前该边界只靠源码注释与 spec 约束：重新加回
// 静态值 import 不会有任何测试失败，公开页 bundle 会被无声撑大并引入无 Desktop 宿主的
// 运行时依赖。这里读取源码做机械断言（照搬 markdownTableStickyScrollbar.test.ts 的
// readFileSync 先例），denylist 模块只允许 `import type`（构建期擦除）。
//
// 盲区修复记录：首版守卫只匹配「行首 + 带 from 子句」的 import，且 denylist 键是 `@/`
// 别名字面量，副作用导入 `import "@/x"`、动态 `import("@/x")`、相对路径
// `from "../../x"`（IDE 自动补全常见产物）三种写法可无声绕过。因此这里把 specifier
// 解析统一归一化后再比对，并覆盖副作用 / 动态 / re-export 三种额外形态。
const UI_SRC_ROOT = fileURLToPath(new URL("../src", import.meta.url));

const SHARE_BOUNDARY_SOURCES = ["v4/ConversationShareReadonlyTimeline.tsx"] as const;

// denylist：会把 Desktop 专属子树拖进公开页 bundle 的模块根。@/OpenSplitButton.js 是
// open-with 子树的入口；其余条目是其 Desktop 专属依赖，防止绕过入口直接静态引入。
// specifier 会先归一化成 @/ 形态，因此 denylist 统一只存别名字面量。
// 新增边界文件或 denylist 条目时在此追加。
const VALUE_IMPORT_DENYLIST: ReadonlySet<string> = new Set([
  "@/OpenSplitButton.js",
  "@/hooks/usePlatform.js",
  "@/hooks/useFileContextActions.js",
  "@/hooks/useWorkspaceOpenInEditorTarget.js",
  "@/lib/editorPreference.js",
  "@/lib/workspaceEditorSelection.js",
  "@/workspace-file-tree/model.js",
]);

type DeniedValueImportKind = "from-clause" | "side-effect" | "dynamic-import";

interface DeniedValueImport {
  specifier: string;
  kind: DeniedValueImportKind;
}

/**
 * 把边界文件里的 import specifier 归一化成 `@/` 别名形态。
 *
 * 修复原因：denylist 只存别名字面量时，`from "../../OpenSplitButton.js"` 这种 IDE
 * 自动补全产物解析到同一模块却比对失败，等于换一种写法就绕过守卫。这里以 ui 包
 * src 根为锚点 resolve 相对路径，折算回别名形态；解析后落在 src 外的（正常不该出现）
 * 保留原样交给字面量比对兜底。分隔符统一成 `/`，保证 Windows 上与 denylist 可比。
 */
function normalizeSpecifier(sourceDir: string, specifier: string): string {
  if (!specifier.startsWith(".")) return specifier;
  const fromSrcRoot = relative(UI_SRC_ROOT, resolve(sourceDir, specifier)).replaceAll("\\", "/");
  return fromSrcRoot.startsWith("..") ? specifier : `@/${fromSrcRoot}`;
}

/**
 * 提取边界源码中所有命中 denylist 的「值引入」。
 *
 * 覆盖四种形态：
 * 1. `import <clause> from "..."` —— 仅 `import type` 构建期擦除，其余计入；
 * 2. `export <clause> from "..."` —— re-export 同样会把值拖进 bundle，同 1 判定；
 * 3. `import "..."` 副作用导入 —— 不存在 type 擦除变体，命中即计入；
 * 4. `import("...")` 动态导入 —— 会为公开页生成异步 chunk，命中即计入。
 * from 子句正则的 `[^"']*?` 含换行，因此多行 import 也能匹配；`^import` 限定行首，
 * 避免命中行尾注释。
 */
function findDeniedValueImports(source: string, sourceDir: string): DeniedValueImport[] {
  const violations: DeniedValueImport[] = [];
  const fromClausePatterns: ReadonlyArray<readonly [RegExp, DeniedValueImportKind]> = [
    [/^import\s+([^"']*?)\s+from\s*["']([^"']+)["']/gm, "from-clause"],
    [/^export\s+([^"']*?)\s+from\s*["']([^"']+)["']/gm, "from-clause"],
  ];
  for (const [pattern, kind] of fromClausePatterns) {
    for (const match of source.matchAll(pattern)) {
      const clause = match[1] ?? "";
      const specifier = normalizeSpecifier(sourceDir, match[2] ?? "");
      // 只认整句 `import type` / `export type`。`import { type X }` 内联形式虽也会被
      // 擦除，但边界文件统一用 `import type` 写法，收紧成单一形态让 denylist 审查
      // 不因两种写法变松。
      if (VALUE_IMPORT_DENYLIST.has(specifier) && !/^type\b/u.test(clause)) {
        violations.push({ specifier, kind });
      }
    }
  }
  const bareSpecifierPatterns: ReadonlyArray<readonly [RegExp, DeniedValueImportKind]> = [
    [/^import\s+["']([^"']+)["']/gm, "side-effect"],
    [/\bimport\s*\(\s*["']([^"']+)["']/g, "dynamic-import"],
  ];
  for (const [pattern, kind] of bareSpecifierPatterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = normalizeSpecifier(sourceDir, match[1] ?? "");
      if (VALUE_IMPORT_DENYLIST.has(specifier)) violations.push({ specifier, kind });
    }
  }
  return violations;
}

describe("conversation share public-page bundle boundary", () => {
  it("分享只读时间线对 open-with 子树只允许 import type 引用", () => {
    for (const sourceRelPath of SHARE_BOUNDARY_SOURCES) {
      const sourcePath = resolve(UI_SRC_ROOT, sourceRelPath);
      const violations = findDeniedValueImports(
        readFileSync(sourcePath, "utf8"),
        dirname(sourcePath),
      );
      expect(
        violations,
        `${sourceRelPath} 对 open-with 子树存在静态值 import（公开页 bundle 边界回归）：` +
          JSON.stringify(violations) +
          "。Desktop 侧能力请改由消费方经组件注入（见 artifactOpenAction 注入契约）。",
      ).toEqual([]);
    }
  });

  // 守卫自身的回归测试：首版正则漏掉的三类写法必须都能被抓到，防止未来改提取器时
  // 重新引入盲区（机器守卫的价值取决于最难被绕过的形态）。
  describe("denylist 提取器形态覆盖（盲区自测）", () => {
    // 用比边界文件更深的虚拟目录模拟 IDE 补全的多层相对路径；relative 只做路径
    // 计算，不要求目录真实存在。
    const sourceDir = resolve(UI_SRC_ROOT, "v4/share/nested");

    it("多层相对路径 from 子句按别名根归一化后命中 denylist", () => {
      const violations = findDeniedValueImports(
        'import { OpenSplitButton } from "../../../OpenSplitButton.js";\n',
        sourceDir,
      );
      expect(violations).toEqual([{ specifier: "@/OpenSplitButton.js", kind: "from-clause" }]);
    });

    it("副作用导入（无 from 子句）命中 denylist", () => {
      const violations = findDeniedValueImports(
        'import "@/OpenSplitButton.js";\n',
        sourceDir,
      );
      expect(violations).toEqual([{ specifier: "@/OpenSplitButton.js", kind: "side-effect" }]);
    });

    it("动态 import() 命中 denylist（公开页会生成异步 chunk）", () => {
      const violations = findDeniedValueImports(
        'const mod = await import("@/OpenSplitButton.js");\n',
        sourceDir,
      );
      expect(violations).toEqual([{ specifier: "@/OpenSplitButton.js", kind: "dynamic-import" }]);
    });

    it("re-export 值形态命中 denylist", () => {
      const violations = findDeniedValueImports(
        'export { OpenSplitButton } from "@/OpenSplitButton.js";\n',
        sourceDir,
      );
      expect(violations).toEqual([{ specifier: "@/OpenSplitButton.js", kind: "from-clause" }]);
    });

    it("import type / export type / 非 denylist 模块不产生违规", () => {
      const violations = findDeniedValueImports(
        [
          'import type { OpenSplitButtonTarget } from "@/OpenSplitButton.js";',
          'export type { OpenSplitButtonTarget } from "@/OpenSplitButton.js";',
          'import { TooltipProvider } from "@/components/ui/tooltip.js";',
          'const x = await import("@zcode/shared");',
        ].join("\n"),
        sourceDir,
      );
      expect(violations).toEqual([]);
    });
  });
});
