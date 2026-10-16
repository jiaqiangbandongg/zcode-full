// 结构性禁令（08-phasing M4 原生重做版，2026-07-06 裁决）：
// zcode-protocol-v4/ 是新协议的原生实现层，禁止 import 旧协议目录（zcode-protocol/）的任何模块。
// 背景：M4 曾被实施为「v4 命令桥翻译回 server-operations」（备份 backup/opus-m4-m5-20260706），
// 桥让旧协议成为实际执行者、e2e 的绿是借旧代码的绿，波次 2/3 永远删不动——本测试把「无桥，
// 新不调老」从口头纪律变成编译期之外的第二道硬闸：任何人（含 agent）想抄近路，此测试先红。
// 允许的方向是反向：旧协议目录里的 binder（如 v4-bridge.ts）可以 import v4 网关做过渡接线，
// 该 binder 随原生 handler 铺全逐条瘦身、随波次 2 删除。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const v4Dir = fileURLToPath(
  new URL("../src/zcode-protocol-v4/", import.meta.url),
);

function collectTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      files.push(...collectTsFiles(fullPath));
      continue;
    }
    if (entry.endsWith(".ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

/** 匹配 import/export ... from "<path>" 与动态 import("<path>") 的模块说明符。 */
function collectImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const staticPattern = /(?:import|export)\s[^;]*?from\s*["']([^"']+)["']/g;
  const dynamicPattern = /import\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const pattern of [staticPattern, dynamicPattern]) {
    for (const match of source.matchAll(pattern)) {
      specifiers.push(match[1]);
    }
  }
  return specifiers;
}

/**
 * 旧协议目录的引用特征：路径含 "zcode-protocol/" 段。
 * 无需排除逻辑："zcode-protocol-v4/" 在 "protocol" 后是 "-v4/" 而非 "/"，字面量天然不匹配；
 * 反而早前加的 (?!.*-v4) 会把 "zcode-protocol/xx-v4.js" 这类旧目录文件误放行（lookahead 漏报）。
 */
function isLegacyProtocolImport(specifier: string): boolean {
  return /(?:^|\/)zcode-protocol\//.test(specifier.replace(/\\/g, "/"));
}

describe("v4 原生边界禁令（无桥）", () => {
  it("zcode-protocol-v4/ 下任何文件不得 import 旧协议目录（zcode-protocol/）", () => {
    const violations: string[] = [];
    for (const file of collectTsFiles(v4Dir)) {
      const source = readFileSync(file, "utf8");
      for (const specifier of collectImportSpecifiers(source)) {
        if (isLegacyProtocolImport(specifier)) {
          violations.push(`${relative(v4Dir, file)} → ${specifier}`);
        }
      }
    }
    expect(
      violations,
      `v4 原生层出现对旧协议的 import（违反 08-phasing M4「无桥」禁令）：\n${violations.join("\n")}`,
    ).toEqual([]);
  });
});
