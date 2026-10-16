// Merge-trap regression for the bind prefix (RC4, round-3 addendum). `h` is a union of a
// PLAIN function and a BOUND one (`f.bind(null, pre)`), so its value carries fns={plain, f}
// plus bound=[pre] — but the set can't say which fn owns the prefix. `h(later)` must reach
// every runtime alignment:
//   - plain's param x = later          (h === plain: no prefix prepended)
//   - f's param a = pre, param b = later (h === bound: prefix [pre] prepended, then later)
// Dropping the no-prefix alignment loses `later -> plain`'s ask; dropping the prefix
// alignment loses `pre -> f`'s ask and `later -> f`'s ask (param b). Dual application keeps
// all three (plus sound spurious cross-edges). Bound dispatch is inexact.
const judge = agent("judge");
const pre = await agent("p").ask<string>("pre");
const later = await agent("l").ask<string>("later");
function plain(x: string): Node<string> {
  return judge.ask<string>(`plain ${x}`);
}
function f(a: string, b: string): Node<string> {
  return judge.ask<string>(`f ${a} ${b}`);
}
const flag = Date.now() % 2 === 0;
const h = flag ? plain : f.bind(null, pre);
const out = await h(later);
return out;
