// never 无法表达为任何值 —— 拒绝（顶层类型实参就是 never）。
const g = agent("g");
const v = await g.ask<never>("go"); // error
log(String(v));
