// A conditional PLACE as an element of a join's array literal. The join element's
// may-alias target is the ternary's canonical place node, whose OWN may-alias targets are
// the two boxes, so a write through the destructured element has to chain through both
// levels to reach box1.f / box2.f. Guards the write-through path across the two node kinds
// this fix made persistent (join results and conditional places) at once.
// Expected: ask#1 -> ask#2 data inexact (via box1.f / box2.f) — the assertion this fixture
// exists for; ask#1 -> join#1 port=0 inexact (the written field is part of the joined
// element, a may-write); ask#2 -> sink.
const box1: { f: string } = { f: "" };
const box2: { f: string } = { f: "" };
const flag = Math.random() > 0.5;
const [el] = await Promise.all([flag ? box1 : box2]);
el.f = await agent("writer").ask<string>("secret");
return agent("reader").ask<string>(`use ${box1.f} and ${box2.f}`);
