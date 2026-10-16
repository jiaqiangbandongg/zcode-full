import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  removeSourceMapFilesInDirectory,
  stripSourceMappingUrlComments,
  stripSourceMappingUrlCommentsInDirectory,
} from "../scripts/packaged-sourcemap-cleanup.mjs";

describe("packaged sourcemap cleanup", () => {
  it("应删除 JS/CSS 里的 sourceMappingURL 注释但保留普通内容", () => {
    expect(
      stripSourceMappingUrlComments(
        [
          "const answer = 42;",
          "//# sourceMappingURL=index.js.map",
          "body{color:red}",
          "/*# sourceMappingURL=index.css.map */",
        ].join("\n"),
      ),
    ).toBe(["const answer = 42;", "body{color:red}"].join("\n"));
  });

  it("应递归清理发布资源目录里的 sourcemap 文件和路径注释", () => {
    const rootDir = mkdtempSync(resolve(tmpdir(), "zcode-sourcemap-cleanup-test-"));
    try {
      const nestedDir = resolve(rootDir, "nested");
      mkdirSync(nestedDir, { recursive: true });
      const jsFile = resolve(nestedDir, "index.js");
      const cssFile = resolve(rootDir, "style.css");
      const mapFile = resolve(nestedDir, "index.js.map");
      const jsonFile = resolve(rootDir, "package.json");

      writeFileSync(jsFile, "console.log('ok');\n//# sourceMappingURL=index.js.map\n");
      writeFileSync(cssFile, ".x{color:red}\n/*# sourceMappingURL=style.css.map */");
      writeFileSync(mapFile, "{}");
      writeFileSync(jsonFile, '{"sourceMappingURL":"keep"}');

      expect(stripSourceMappingUrlCommentsInDirectory(rootDir)).toEqual({
        filesChanged: 2,
        referencesRemoved: 2,
      });
      expect(removeSourceMapFilesInDirectory(rootDir)).toEqual({ filesRemoved: 1 });

      expect(readFileSync(jsFile, "utf8")).toBe("console.log('ok');\n");
      expect(readFileSync(cssFile, "utf8")).toBe(".x{color:red}");
      expect(readFileSync(jsonFile, "utf8")).toBe('{"sourceMappingURL":"keep"}');
      expect(existsSync(mapFile)).toBe(false);
    } finally {
      rmSync(rootDir, { force: true, recursive: true });
    }
  });
});
