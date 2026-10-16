// The control for strand-async-helper-unawaited: the same helper, awaited at its call site.
// `await h()` spawns the strand and joins it in one expression, so the picture is the plain
// sequential one the analyzer has always drawn — the helper's step is settled before the
// middle ask issues.
//
// This is the fixture that says the refactor did not cost anything: a strand is a fork only
// when the script actually leaves it running.
//
// Expected:
//   core — `region call#1 call parent=seq#1 … label="h" strand` (the flag rides the region
//     whatever the call site does with the promise) and `settle ask#1 in=seq#1 joins=call#1`
//     on the main line, right after the call's `jump return`. The strand is spawned while
//     evaluating the operand, so it joins syntactically.
//   causality — the sequential picture: `ask#1 -> ask#2 seq` and both feeding `ask#3` by
//     `data`.
//   cfg — no `alongside` anywhere, and `ask#1@1 -> ask#2@1 join via=return`: the strand's
//     exit lands on the middle ask, one node later than the `fork` that spawned it.
async function h(): Promise<string> {
  return await agent("h").ask<string>("h");
}

const hv = await h();
const mid = await agent("m").ask<string>("m");
return await agent("l").ask<string>(hv + mid);
