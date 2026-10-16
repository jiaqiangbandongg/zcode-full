// Spread actual over a tracked tuple: f(...pair) runs f("clean", secret) — b IS
// secret at runtime and flows into ask#2. The analyzer evaluates the spread as ONE
// actual at index 0 (collapsed pair), so param b's placeholder (index 1) resolves
// to nothing — probing positional resolution of spread actuals.
const judge = agent("judge");
const secret = await agent("s").ask<string>("make secret");
function f(a: string, b: string): Node<string> {
  log(a);
  return judge.ask<string>(`judge ${b}`);
}
const pair: [string, string] = ["clean", secret];
const out = await f(...pair);
return out;
