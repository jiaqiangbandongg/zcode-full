import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { keepKindLines } from "./kind-filter.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const registries = ["ui/viewers/registry.ts", "src/adapters/parsers.ts"];
const kindTags = (source) => [...source.matchAll(/ \/\/ kind:(\w+)/g)].map((match) => match[1]);

describe("keepKindLines", () => {
  // 回归：Windows 检出的 .ts 是 CRLF，行尾残留 \r 曾让标记匹配失败，单格式插件保留了全部渲染器。
  for (const eol of ["\n", "\r\n"]) {
    const label = eol === "\n" ? "LF" : "CRLF";
    for (const file of registries) {
      it(`keeps only the plugin's formats in ${file} (${label})`, async () => {
        const source = (await readFile(join(root, file), "utf8")).replace(/\r?\n/g, eol);
        expect(new Set(kindTags(source))).toEqual(new Set(["docx", "pdf", "pptx", "xlsx"]));
        expect(new Set(kindTags(keepKindLines(source, ["docx"])))).toEqual(new Set(["docx"]));
        expect(new Set(kindTags(keepKindLines(source, ["xlsx", "pdf"])))).toEqual(
          new Set(["xlsx", "pdf"]),
        );
      });
    }
  }

  it("keeps untagged lines", () => {
    expect(keepKindLines("a\r\nb // kind:pdf\r\nc", ["docx"])).toBe("a\nc");
  });
});
