import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseSavedWorkflow,
  resolveSavedWorkflow,
  saveSavedWorkflow,
  serializeSavedWorkflow,
} from "../src/tool/handlers/saved-workflows/index.js";

// docs/dynamic-workflow/launch.md「Diagnostics in file lines」：诊断要按**文件行**报出来，
// 而编译看的是正文。两套行号相差的那个常数只能由解析器给出——让每个调用点自己数一遍，
// 正是「诊断行号对不上文件」的标准产地。

describe("parseSavedWorkflow — bodyLineOffset", () => {
  it("正文之前的行数 = 起始标记 + YAML + 终止行", () => {
    const source = serializeSavedWorkflow({ description: "d" }, "return 1;\n");
    const parsed = parseSavedWorkflow(source);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // 头行 + `description: d` + 终止行 = 3。
    expect(parsed.bodyLineOffset).toBe(3);
    // 偏移的定义就是这个等式：正文第 n 行 = 文件第 n + offset 行。
    const fileLines = source.split("\n");
    expect(fileLines[parsed.bodyLineOffset]).toBe("return 1;");
  });

  it("前导空行也算进去", () => {
    const source = `\n\n${serializeSavedWorkflow({ description: "d" }, "return 1;\n")}`;
    const parsed = parseSavedWorkflow(source);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.bodyLineOffset).toBe(5);
    expect(source.split("\n")[parsed.bodyLineOffset]).toBe("return 1;");
  });

  it("多行 args 声明同样对得上", () => {
    const source = serializeSavedWorkflow(
      { description: "d", args: { pr: { type: "string", required: true } } },
      "const x = 1;\nreturn x;\n",
    );
    const parsed = parseSavedWorkflow(source);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(source.split("\n")[parsed.bodyLineOffset]).toBe("const x = 1;");
    expect(source.split("\n")[parsed.bodyLineOffset + 1]).toBe("return x;");
  });
});

describe("resolveSavedWorkflow — source / bodyLineOffset", () => {
  it("带回文件原文（草稿拷贝拿的就是它）与偏移", () => {
    const cwd = mkdtempSync(join(tmpdir(), "dwf-frontmatter-"));
    try {
      const { path } = saveSavedWorkflow({
        cwd,
        name: "nightly",
        meta: { description: "d" },
        script: "return 1;\n",
      });
      const found = resolveSavedWorkflow({ cwd, name: "nightly" });
      expect(found.ok).toBe(true);
      if (!found.ok) return;
      expect(found.path).toBe(path);
      // 原文 = 元数据块 + 正文，逐字节；重新序列化一遍会让手写的 YAML 排版在拷贝里漂移。
      expect(found.source).toBe(serializeSavedWorkflow({ description: "d" }, "return 1;\n"));
      expect(found.source.split("\n")[found.bodyLineOffset]).toBe("return 1;");
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });
});
