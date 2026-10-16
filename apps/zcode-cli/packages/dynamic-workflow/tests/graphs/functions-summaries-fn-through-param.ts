// A script-local function passed as an argument to another script-local function and
// invoked through the parameter. The fn value must flow through recordCall's param
// binding and dispatch inside run; secret flows caller -> run -> g -> ask.
// Expected: ask#1 -> ask#2 data (exactness either way); ask#2 -> sink data.
const judge = agent("judge");
const secret = await agent("s").ask<string>("secret");
async function run(g: (v: string) => Node<string>, v: string): Promise<string> {
  return await g(v);
}
const out = await run((x: string) => judge.ask<string>(`judge ${x}`), secret);
return out;
