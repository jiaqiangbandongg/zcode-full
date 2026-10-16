// Reflect.apply(f, null, [secret]): the same runtime dispatch as f.apply, but here f
// rides in the ARGUMENTS of an unknown call, so the keystone rule pessimistically
// applies it with the receiver-union — the flow should survive (inexact).
// Expected: ask#1 -> ask#2 data inexact; ask#2 -> sink data.
const judge = agent("judge");
const secret = await agent("s").ask<string>("make secret");
function f(x: string): Node<string> {
  return judge.ask<string>(`judge ${x}`);
}
const out = await Reflect.apply(f, null, [secret]);
return out;
