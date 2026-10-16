// f.apply(null, [secret]): runtime binds x = secret, which flows into ask#2.
// The analyzer sees actuals [null, [secret]] — param 0 gets null's empty taint and
// the args-array taint sits at actual index 1, never read by param 0's placeholder.
const judge = agent("judge");
const secret = await agent("s").ask<string>("make secret");
function f(x: string): Node<string> {
  return judge.ask<string>(`judge ${x}`);
}
const out = await f.apply(null, [secret]);
return out;
