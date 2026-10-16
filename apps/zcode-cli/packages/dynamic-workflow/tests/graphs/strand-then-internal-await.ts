// A `.then` continuation that awaits inside itself, registered and only later awaited
// through the variable it was bound to. The continuation is a deferred strand: its first
// event is the ordinary barrier over its receiver (the writer's ask), and the edit it awaits
// belongs to the strand's frame, never to the main line.
//
// This is the "edge disappears" case the plan predicted and no existing fixture has: the
// side ask is issued between the registration and `await q`, and under the old global
// `settle maybe` it collected a `seq maybe` arrow from the receiver's step. It gets none now.
//
// The join at `await q` is the bound-variable half of the awaited-position scan: `q` is the
// operand, `strandsBySymbol` holds the strand spawned while its declaration was evaluated,
// and the strand's summary carries BOTH the receiver's step (settled by the prologue) and
// the editor's (settled by the callback's own await).
//
// Expected:
//   core — `region call#1 call parent=seq#1>choice#1>branch#1 … label="then" strand` (the
//     continuation runs iff the receiver fulfils, hence the skippable choice), a CERTAIN
//     `settle ask#1` prologue inside it, `settle ask#2` inside it too, `settle ask#3 in=seq#1`
//     for the side ask, and `settle ask#1,ask#2 in=seq#1 joins=call#1` at `await q`.
//   causality — `ask#1 -> ask#2 data` (the draft feeds the edit) and NO edge from either
//     ask#1 or ask#2 into ask#3.
//   cfg — `ask#2@1 -> sink join via=return`: the editor's ask leaves by the barrier at
//     `await q`, which is the last node, not by the sequential line through the side ask.
//     `ask#1@1 -> ask#3@1 branch` is the skip arm of the choice, the main line walking past
//     a continuation that may never run.
const p = agent("w").ask<string>("draft");
const q = p.then(async (t) => {
  const e = await agent("e").ask<string>("edit " + t);
  return e;
});
const side = await agent("s").ask<string>("side");
const out = await q;
return out + side;
