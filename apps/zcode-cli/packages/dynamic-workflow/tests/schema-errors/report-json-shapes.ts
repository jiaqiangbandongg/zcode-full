// 正向覆盖：普通 JSON 形状与 `unknown` 都通过，一条诊断都不该有。
// 这条 fixture 存在的意义是防止"把 report 的检查写严到没人能用"——`unknown` 在发射器里
// 是合法的 any-JSON，而脚本里大量的中间值正是 unknown。
interface Finding {
  path: string;
  line: number;
  note?: string;
}

const g = agent("g");
const text = await g.ask<string>("go");
const anything: unknown = JSON.parse(text);

report({ paths: ["a.ts", "b.ts"], total: 2, clean: false, extra: null });
report(anything);
report(text);
report([1, 2, 3]);
const finding: Finding = { path: "a.ts", line: 3 };
report(finding);
