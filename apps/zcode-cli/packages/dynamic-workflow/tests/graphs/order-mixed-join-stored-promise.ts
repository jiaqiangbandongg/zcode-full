// A stored promise joined with a freshly-issued one. This is the case phase 1 got WRONG
// rather than merely imprecisely: the awaited expression ISSUES the fresh ask, so the
// syntactic rule found a non-empty settle set and the barrier never widened — and `held`,
// whose promise this same `await` genuinely waits for, was never settled at all. The
// picture left it incomparable with the trailing step, i.e. it invented concurrency the
// script does not have, which is the one direction the design promises never to take.
// Phase 2's oracle settles it; the claim is `maybe` because a two-witness join set cannot
// be told apart from `Promise.race`, which settles exactly one of its inputs.
// Expect: ask#1 -> ask#3 seq maybe, ask#2 -> ask#3 seq always.
const held = agent("slow").ask<string>("A");
const [x, y] = await Promise.all([held, agent("fresh").ask<string>("B")]);
const after = await agent("after").ask<string>("C");
return `${x} ${y} ${after}`;
