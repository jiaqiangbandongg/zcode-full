// Rest parameter must gather EVERY actual past its position: joinAll(a, b) binds
// parts = [a, b], so both ask#1 and ask#2 reach ask#3 through `...parts`.
function joinAll(...parts: string[]): string {
  return parts.join(" ");
}
const a = await agent("a").ask<string>("A");
const b = await agent("b").ask<string>("B");
const r = joinAll(a, b);
const c = await agent("c").ask<string>(`use ${r}`);
return c;
