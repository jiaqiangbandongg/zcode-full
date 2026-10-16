// g = f.bind(null, secret); g() — at runtime g() is f(secret): secret flows into
// ask#2 and the ask result flows to the sink. The bind call misaligns actuals
// (param 0 <- null) AND the bound function value g carries only f's substituted
// summary (no .fns), so the later g() is an unknown call returning nothing.
const judge = agent("judge");
const secret = await agent("s").ask<string>("make secret");
function f(x: string): Node<string> {
  return judge.ask<string>(`judge ${x}`);
}
const g = f.bind(null, secret);
const out = await g();
return out;
