// Default parameter referencing an EARLIER parameter: f(secret) leaves b to default
// to a, so secret flows a -> b -> ask#2. The initializer is evaluated in the
// function's own context where `a` is the param-0 placeholder.
// Expected: ask#1 -> ask#2 data exact; ask#2 -> sink data exact.
const judge = agent("judge");
const secret = await agent("s").ask<string>("secret");
function f(a: string, b: string = a): Node<string> {
  return judge.ask<string>(`judge ${b}`);
}
const out = await f(secret);
return out;
