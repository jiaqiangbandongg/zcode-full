// SYNTACTICALLY nested conditional place: the inner ternary is an ARM of the outer one,
// so its place wrapper lands directly in the outer wrapper's may-alias set. Divergence
// repro: that wrapper used to be rebuilt every fixpoint pass, defeating the identity dedup
// the may-alias union relies on, and the analysis ran to ITERATION_CAP. (The chained form
// `a = flag ? b : c; d = flag2 ? a : e` converged only because binding `a` to an env slot
// made its wrapper persistent by accident — heap-aliasing-chained-ternary-alias-write.)
// Conditional places are now canonical per ternary node.
// Expected: ask#1 -> ask#2 data inexact (the write may land on any of the three boxes);
// ask#2 -> sink.
const box1: { p: string } = { p: "" };
const box2: { p: string } = { p: "" };
const box3: { p: string } = { p: "" };
const flag = Math.random() > 0.5;
const flag2 = Math.random() > 0.5;
const x = flag2 ? (flag ? box1 : box2) : box3;
x.p = await agent("writer").ask<string>("secret");
return agent("reader").ask<string>(`use ${box1.p} and ${box2.p} and ${box3.p}`);
