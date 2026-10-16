// f.call(null, secret): at runtime f's param x IS secret and flows into ask#2.
// The analyzer treats `f.call` as a call of f with the thisArg occupying actual
// index 0, so param 0 receives null's (empty) taint — probing whether the
// positional misalignment drops the ask#1 -> ask#2 edge.
const judge = agent("judge");
const secret = await agent("s").ask<string>("make secret");
function f(x: string): Node<string> {
  return judge.ask<string>(`judge ${x}`);
}
const out = await f.call(null, secret);
return out;
