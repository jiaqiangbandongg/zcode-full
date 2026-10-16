// 非可选位置上的 undefined 成员 —— 拒绝（可选性应通过 `?` 表达，而不是 `| undefined`）。
interface R {
  value: string | undefined;
}

const g = agent("g");
const v = await g.ask<R>("go"); // error
log(JSON.stringify(v));
