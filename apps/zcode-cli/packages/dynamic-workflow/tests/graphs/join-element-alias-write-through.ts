// Alias an element of a Promise.all result and write a NEW field through the alias, then
// read it back by static index. Confirms aliasing write-through into a join element AND
// join-port precision survive together (port=0 preserved on the join edge).
interface R {
  g: string;
}
const a = agent("wa");
const b = agent("wb");
const res = await Promise.all([a.ask<R>("x"), b.ask<R>("y")]);
const first = res[0];
const secret = await agent("wc").ask<string>("secret");
first.g = secret;
const out = await agent("reader").ask<string>(`use ${res[0].g}`);
return out;
