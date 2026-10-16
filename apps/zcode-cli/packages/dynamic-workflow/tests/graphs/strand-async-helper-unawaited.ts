// An `async` helper called but not awaited: `const p = h()` starts the helper's activation
// and hands back a promise. Everything the helper awaits is concurrent with what the main
// line does next, and ordered only by the LATER `await p`.
//
// The join at `await p` comes from the awaited-position scan on a bare identifier: `p` is
// the operand itself, so the strands bound to it (strandsBySymbol, filled where the walk
// binds steps to a declaration) are joined and their SUMMARY — what the strand itself
// awaited — settles on the main line.
//
// Expected:
//   core — `region call#1 call parent=seq#1 … label="h" strand`; `settle ask#1 in=seq#1>call#1`
//     inside it (the helper's own await); `settle ask#2 in=seq#1` for the middle ask; then
//     `settle ask#1 in=seq#1 joins=call#1` at `await p`.
//   causality — NO edge between ask#1 (the helper's) and ask#2 (the middle one), and
//     `ask#1 -> ask#3 data` plus `ask#2 -> ask#3 data` into the last ask, whose prompt reads
//     both answers.
//   cfg — `entry -> ask#1@1 fork` beside `entry -> ask#2@1 next` (the spawner walked on),
//     and `ask#1@1 -> ask#3@1 join via=return`: the strand rejoins at the node after
//     `await p`, never at the middle ask.
async function h(): Promise<string> {
  return await agent("h").ask<string>("h");
}

const p = h();
const mid = await agent("m").ask<string>("m");
const hv = await p;
return await agent("l").ask<string>(hv + mid);
