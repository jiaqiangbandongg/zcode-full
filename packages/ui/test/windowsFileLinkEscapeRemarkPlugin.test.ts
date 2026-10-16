import remarkParse from "remark-parse";
import { unified } from "unified";
import { describe, expect, it } from "vitest";
import { windowsFileLinkEscapeRemarkPlugin } from "../src/lib/windowsFileLinkEscapeRemarkPlugin.js";

interface ProbeNode {
  children?: ProbeNode[];
  type: string;
  url?: string;
}

function collectUrls(markdown: string): string[] {
  const processor = unified().use(remarkParse).use(windowsFileLinkEscapeRemarkPlugin);
  const file = processor.parse(markdown);
  const tree = processor.runSync(file, markdown) as ProbeNode;

  const urls: string[] = [];
  const visit = (node: ProbeNode): void => {
    if (
      (node.type === "link" || node.type === "image" || node.type === "definition") &&
      typeof node.url === "string"
    ) {
      urls.push(node.url);
    }
    node.children?.forEach(visit);
  };
  visit(tree);
  return urls;
}

describe("windowsFileLinkEscapeRemarkPlugin", () => {
  it("restores the backslash CommonMark ate before a dot-prefixed directory", () => {
    // 现场：PowerShell 兜底截图落在 .zcode 下，`\.` 被当作标点转义吃掉，
    // 预览请求 C:/Users/dev.zcode/... 直接 ENOENT。
    expect(
      collectUrls(
        String.raw`[screenshot.png](C:\Users\dev\.zcode\workspace\default\screenshot.png)`,
      ),
    ).toEqual([String.raw`C:\Users\dev\.zcode\workspace\default\screenshot.png`]);
  });

  it("restores image destinations the same way as links", () => {
    expect(
      collectUrls(String.raw`![shot](C:\Users\dev\.zcode\workspace\default\shot.png)`),
    ).toEqual([String.raw`C:\Users\dev\.zcode\workspace\default\shot.png`]);
  });

  it("restores UNC destinations whose leading pair collapsed to one backslash", () => {
    // 源码里的 `\\host` 中 `\\` 自身就是一次标点转义，解析后只剩一个反斜杠。
    expect(collectUrls(String.raw`[log](\\build01\share\.logs\run.txt)`)).toEqual([
      String.raw`\\build01\share\.logs\run.txt`,
    ]);
  });

  it("leaves Windows paths that lost nothing untouched", () => {
    const markdown = String.raw`[app](C:\Users\dev\z-code\src\app.ts)`;
    expect(collectUrls(markdown)).toEqual([String.raw`C:\Users\dev\z-code\src\app.ts`]);
  });

  it("restores forward-slash drive paths that still contain an escaped punctuation", () => {
    expect(collectUrls(String.raw`[shot](C:/Users/dev/\.zcode/shot.png)`)).toEqual([
      String.raw`C:/Users/dev/\.zcode/shot.png`,
    ]);
  });

  it("ignores non-Windows destinations", () => {
    expect(
      collectUrls(
        ["[docs](https://example.com/a.b)", "[rel](./src/app.ts)", "[abs](/tmp/.cache/x)"].join(
          "\n\n",
        ),
      ),
    ).toEqual(["https://example.com/a.b", "./src/app.ts", "/tmp/.cache/x"]);
  });

  it("skips destinations carrying a title rather than guessing where it starts", () => {
    // fail closed：title 语法一旦参与切片就可能把引号算进路径，宁可不还原。
    expect(collectUrls(String.raw`[shot](C:\Users\dev\.zcode\a.png "标题")`)).toEqual([
      String.raw`C:\Users\dev.zcode\a.png`,
    ]);
  });

  it("skips angle-bracket destinations", () => {
    expect(collectUrls(String.raw`[shot](<C:\Users\dev\.zcode\a.png>)`)).toEqual([
      String.raw`C:\Users\dev.zcode\a.png`,
    ]);
  });

  it("restores reference-style definitions that back a link reference", () => {
    // 引用式链接的 URL 由 definition 提供，同一处转义丢失在这条路径上同样成立。
    const markdown = [
      String.raw`[shot][ref]`,
      "",
      String.raw`[ref]: C:\Users\dev\.zcode\a.png`,
    ].join("\n");

    expect(collectUrls(markdown)).toEqual([String.raw`C:\Users\dev\.zcode\a.png`]);
  });

  it("keeps the parsed url when the raw slice does not round-trip", () => {
    // 实体引用会在解析期被解开，反转义等式不成立 → 放弃还原。
    expect(collectUrls(String.raw`[shot](C:\Users\a&amp;b\.zcode\a.png)`)).toEqual([
      String.raw`C:\Users\a&b.zcode\a.png`,
    ]);
  });
});
