// Context-sensitive returns: `relay` returns its argument. Called with two distinct
// ask results, each feeding a distinct downstream ask. The two chains must NOT
// cross-contaminate: ask#1 -> ask#3 and ask#2 -> ask#4 only (no ask#1 -> ask#4).
function relay(v: string): string {
  return v;
}

const a = await agent("a1").ask<string>("A");
const b = await agent("b1").ask<string>("B");
const ra = relay(a);
const rb = relay(b);
const c = await agent("c1").ask<string>(`use ${ra}`);
const d = await agent("d1").ask<string>(`use ${rb}`);
return `${c} ${d}`;
