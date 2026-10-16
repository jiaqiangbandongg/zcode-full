// Chained assignment `x = y = t` taints BOTH targets (nested EqualsToken). Positive
// coverage locking in the currently-correct behavior so a fix to the sibling
// compound/destructuring-assignment bugs cannot regress it.
// Expected: ask#1 -> ask#2, ask#1 -> ask#3, and both -> sink.
const t = await agent("alpha").ask<string>("one");
let x = "";
let y = "";
x = y = t;
const b = await agent("beta").ask<string>(`X: ${x}`);
const c = await agent("gamma").ask<string>(`Y: ${y}`);
return `${b} ${c}`;
