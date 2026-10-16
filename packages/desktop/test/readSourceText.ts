import { readFileSync } from "node:fs";

// Bugfix 原因：Windows 检出（core.autocrlf=true）的工作区文本是 CRLF，而源码契约
// 断言统一以 LF 书写；多行 toContain / indexOf 边界在 CRLF 文本上必然失配，
// 表现为"片段存在但断言失败"。契约测试读取源码一律经由这里做换行归一化。
// 与 packages/ui/test/readSourceText.ts 同构，测试工具跨包共享会引入耦合，故各自维护。
export function readSourceText(path: string | URL, encoding: BufferEncoding = "utf8"): string {
  return readFileSync(path, encoding).replace(/\r\n/g, "\n");
}
