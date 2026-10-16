// Late alias: the aliasing assignment `wrap.box = box` sits AFTER the write in
// source order; the loop makes the write hit the alias at runtime (iteration 2
// writes through wrap.box === box). Flow-insensitivity must make order irrelevant.
// Expected: ask#1 -> ask#2 data; ask#2 -> sink.
const box: { f: string } = { f: "" };
const wrap: { box?: { f: string } } = {};
for (let i = 0; i < 2; i++) {
  if (wrap.box !== undefined) wrap.box.f = await agent("writer").ask<string>("secret");
  wrap.box = box;
}
return agent("reader").ask<string>(`use ${box.f}`);
