// Destructuring assignment expressions (not declarations) must bind their targets:
// `[x, y] = ["lit", a]` assigns y = a; `({ p } = { p: a })` assigns p = a.
const a = await agent("alpha").ask<string>("one");
let x = "";
let y = "";
[x, y] = ["lit", a];
let p = "";
({ p } = { p: a });
const b = await agent("beta").ask<string>(`Got: ${x} ${y} ${p}`);
return b;
