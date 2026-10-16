// ============================================================
// 故障矩阵的并行度轴：八个脚本形状（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Verification」）
// ============================================================
// 所有脚本共用同一个返回类型 `Out { note: string }` 与同一种 persona，只有形状不同。
// 每个 ask 都是**自己的子代理实例**（`agent(\`w-${i}\`)` 写在 map 回调里），否则 fan-out
// 会退化成一个共享会话上的串行 ask（authoring skill §7 的那条纪律）。
// `parallel` 在 dwf 里就是「不 await 直到 Promise.all」；`pipeline` 是两级 Promise.all，
// 第二级以第一级的结果为输入（扇入）。

export type ScriptShape = "W1" | "W2" | "W4" | "W8" | "W16" | "S-pipe" | "S-nest" | "S-phase";

export interface ShapeSpec {
  script: string;
  /** 同时在飞的子代理数上限（由脚本形状决定）。 */
  parallelism: number;
  /** 整个 run 创建的子代理数。 */
  subagents: number;
  /** ask 站点实例总数（= 子代理数：每个子代理恰好一次 ask）。 */
  asks: number;
}

const HEADER = ["interface Out { note: string }", 'const PERSONA = "You are a test worker.";'].join(
  "\n",
);

/** 平铺 fan-out：宽度 n。 */
function flat(n: number): string {
  if (n === 1) {
    return [
      HEADER,
      'const out = await agent("w-1", PERSONA).ask<Out>("Do task 1.");',
      "return out.note;",
    ].join("\n");
  }
  return [
    HEADER,
    `const items = [${Array.from({ length: n }, (_, i) => i + 1).join(", ")}];`,
    "const outs = await Promise.all(",
    "  items.map((i) => agent(`w-${i}`, PERSONA).ask<Out>(`Do task ${i}.`)),",
    ");",
    "return outs.map((o) => o.note);",
  ].join("\n");
}

const PIPE = [
  HEADER,
  "const first = await Promise.all(",
  "  [1, 2, 3, 4].map((i) => agent(`s1-${i}`, PERSONA).ask<Out>(`Stage one, task ${i}.`)),",
  ");",
  "const second = await Promise.all(",
  "  first.map((o, i) => agent(`s2-${i + 1}`, PERSONA).ask<Out>(`Stage two on: ${o.note}`)),",
  ");",
  "return second.map((o) => o.note);",
].join("\n");

const NEST = [
  HEADER,
  "const groups = await Promise.all(",
  "  [1, 2, 3].map((g) =>",
  "    Promise.all(",
  "      [1, 2, 3].map((i) => agent(`g${g}-w${i}`, PERSONA).ask<Out>(`Group ${g}, task ${i}.`)),",
  "    ),",
  "  ),",
  ");",
  "return groups.flat().map((o) => o.note);",
].join("\n");

const PHASE = [
  HEADER,
  'phase("Stage A");',
  "const a = await Promise.all(",
  "  [1, 2, 3, 4].map((i) => agent(`a-${i}`, PERSONA).ask<Out>(`Stage A, task ${i}.`)),",
  ");",
  'phase("Gate");',
  'const gate = await agent("gate", PERSONA).ask<Out>(`Gate on ${a.length} results.`);',
  'phase("Stage B");',
  "const b = await Promise.all(",
  "  [1, 2, 3, 4].map((i) => agent(`b-${i}`, PERSONA).ask<Out>(`Stage B, task ${i}, after ${gate.note}.`)),",
  ");",
  "return b.map((o) => o.note);",
].join("\n");

export const FAULT_MATRIX_SHAPES: Record<ScriptShape, ShapeSpec> = {
  W1: { script: flat(1), parallelism: 1, subagents: 1, asks: 1 },
  W2: { script: flat(2), parallelism: 2, subagents: 2, asks: 2 },
  W4: { script: flat(4), parallelism: 4, subagents: 4, asks: 4 },
  W8: { script: flat(8), parallelism: 8, subagents: 8, asks: 8 },
  W16: { script: flat(16), parallelism: 16, subagents: 16, asks: 16 },
  "S-pipe": { script: PIPE, parallelism: 4, subagents: 8, asks: 8 },
  "S-nest": { script: NEST, parallelism: 9, subagents: 9, asks: 9 },
  "S-phase": { script: PHASE, parallelism: 4, subagents: 9, asks: 9 },
};

export const FAULT_MATRIX_SHAPE_IDS = Object.keys(FAULT_MATRIX_SHAPES) as ScriptShape[];
