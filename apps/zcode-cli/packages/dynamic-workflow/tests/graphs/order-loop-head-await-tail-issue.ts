// The regression guard for phase 2's repetition demotion: a loop whose HEAD awaits the
// promise its TAIL issued. Iteration k+1's `await box` settles iteration k's ask, so the
// oracle admits ask#1 by repetition even though the walk has not issued it yet — but that
// settle must be a MAY-claim, never certain, because the claim fails at both ends of the
// loop. The first iteration awaits the initial (empty) value and settles nothing, and the
// LAST iteration issues ask#1 and then exits: the head await of iteration k+1 never runs,
// so that instance is still pending when ask#2 issues. A certain settle here would emit
// `ask#1 -> ask#2 seq always`, asserting a post-loop ordering the final instance violates.
//
// The loop is a literal-bounded `for` ON PURPOSE. Edges inherit the weaker certainty of
// their endpoints, so inside a `while` (never provably entered) ask#1 would be `maybe` and
// drag the edge to `maybe` whatever the settle claimed — the fixture would pass either way
// and guard nothing. A positive literal bound makes ask#1 `always` (finding (a)), so the
// edge's certainty is decided by the SETTLE, which is exactly what this pins.
// Expect: ask#1 -> ask#2 seq MAYBE (plus the loop's own carry self-edge).
let box: Node<string> | undefined;
for (let round = 0; round < 3; round++) {
  const prev = await box;
  box = agent("refiner").ask<string>(`refine ${prev}`);
}
const final = await agent("wrapper").ask<string>("wrap up");
return final;
