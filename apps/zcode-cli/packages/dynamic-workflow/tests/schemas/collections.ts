// 数组、只读数组、元组（定长/可选/rest）、Record → additionalProperties。
interface Collections {
  tags: string[];
  frozen: readonly number[];
  pair: [string, number];
  optionalTail: [string, number?];
  restTail: [string, ...number[]];
  scores: Record<string, number>;
  matrix: number[][];
}

const g = agent("collector");
const out = await g.ask<Collections>("gather collections");
log(JSON.stringify(out));
