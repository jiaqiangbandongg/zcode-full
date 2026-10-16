// The reference shape of the strands refactor. Two phases each fan out `async` work and
// neither awaits it, so B's marker is reached while A's subagents are still running; one
// barrier then joins both fan-outs, and C fans out over their answers. A ∥ B → C.
//
// Under the old single settled set the `await` inside A's callback settled ask#1 for the
// WHOLE script, so `ask#1 -> ask#2 seq` appeared and the control flow threaded A → B → C on
// one line — byte-identical to strand-fanout-awaited-per-phase, which really is sequential.
// A fan-out with an `async` literal callback is a strand: its awaits suspend the element's
// activation, not the spawner.
//
// Expected:
//   core — `region fanout#1 … strand` and `region fanout#2 … strand`; each callback's own
//     `settle ask#N in=seq#1>fanout#N`; and ONE certain barrier on the main line,
//     `settle ask#1,ask#2 in=seq#1 joins=fanout#1,fanout#2`.
//   causality — NO edge of any kind between ask#1 and ask#2 (concurrency is
//     incomparability in the partial order, so it needs no ink), both `-> ask#3 data`, and
//     the forward phase edges are `phase#1 -> phase#3` and `phase#2 -> phase#3` only (the
//     `carry` self-edges every may-repeat fan-out raises are not forward edges).
//   cfg — `phase#1@1 -> phase#2@1 next` (the spawner walked marker to marker),
//     `ask#1@1 -> phase#3@1 join via=return`, `ask#2@1 -> phase#3@1 join via=return`, and
//     `phase phase#2 "B" alongside=phase#1`: B was entered beside A, which is a node fact,
//     not a transfer of control.
const ids = [1, 2, 3];

phase("A");
const aWork = ids.map(async (i) => {
  const r = await agent(`a-${i}`).ask<string>(`survey ${i}`);
  return r;
});

phase("B");
const bWork = ids.map(async (i) => {
  const r = await agent(`b-${i}`).ask<string>(`probe ${i}`);
  return r;
});

const [a, b] = await Promise.all([Promise.all(aWork), Promise.all(bWork)]);

phase("C");
const merged = await Promise.all(
  ids.map(async (i) => {
    const r = await agent(`c-${i}`).ask<string>(`${a.join(",")} / ${b.join(",")} #${i}`);
    return r;
  }),
);
return merged;
