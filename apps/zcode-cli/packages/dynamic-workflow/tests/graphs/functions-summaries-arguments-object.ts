// The `arguments` object: f(secret) binds arguments[0] = secret at runtime, which
// flows into ask#2 even though the named param is never read. Probes whether call
// mechanics model the arguments object at all.
const judge = agent("judge");
const secret = await agent("s").ask<string>("make secret");
function f(_x: string): Node<string> {
  return judge.ask<string>(`judge ${String(arguments[0])}`);
}
const out = await f(secret);
return out;
