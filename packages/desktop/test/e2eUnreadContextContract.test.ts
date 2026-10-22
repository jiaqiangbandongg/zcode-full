import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

it("MRO03 pending与formal保持普通上下文，显式compact用例仍用小窗口", async () => {
  const source = await readFile(resolve(import.meta.dirname, "../wdio.conf.ts"), "utf8");
  const file = ts.createSourceFile("wdio.conf.ts", source, ts.ScriptTarget.Latest, true);
  const expressions = new Map<string, string>();
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
      expressions.set(node.name.text, node.initializer.getText(file));
    ts.forEachChild(node, visit);
  };
  visit(file);
  const auto = expressions.get("autoCompactSpec");
  const window = expressions.get("contextWindow");
  if (!auto || !window) throw new Error("Missing real WDIO replay context configuration");
  // 执行实际配置表达式；其它专项布尔门禁均关闭，避免为测试import启动整套WDIO。
  const unrelated = [
    ...new Set([...auto.matchAll(/!([A-Za-z]+Spec)\b/gu)].map((match) => match[1]!)),
  ];
  const readWindow = new Function(
    "specs",
    "upstreamE2EContextWindowOverride",
    ...unrelated,
    `const autoCompactSpec = ${auto}; return ${window};`,
  ) as (specs: string[], override: undefined, ...flags: boolean[]) => number;
  for (const path of [
    "./test/e2e/conversation-session/manual-review/pending/conversation-session-web-remote-unread.test.ts",
    "./test/e2e/conversation-session/conversation-session-web-remote-unread.test.ts",
  ])
    expect(readWindow([path], undefined, ...unrelated.map(() => false))).toBe(128000);
  expect(
    readWindow(
      ["./test/e2e/conversation-session/conversation-session-compact-auto.test.ts"],
      undefined,
      ...unrelated.map(() => false),
    ),
  ).toBe(240);
});
