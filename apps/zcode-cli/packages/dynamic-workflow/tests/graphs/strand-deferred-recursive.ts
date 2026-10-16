// A `.then` continuation that re-enters its own function: `refine` registers a continuation
// which, when the answer is still too long, calls `refine` again.
//
// PINS A RESIDUAL, NOT A DESIRED RESULT. `inlineBody` cuts recursion by returning as soon as
// `fnStack` already holds the declaration, and that return happens BEFORE the region is
// opened and before the prologue would run. A deferred callback's prologue IS its receiver
// barrier, so round 2's ask is never ordered before round 2's continuation: the whole second
// round is one `jump recur`. The goldens below are what the analyzer does today; the fixture
// exists so that a change to the recursion cut arrives as a reviewed diff, not as silence.
//
// What the core trace shows, in order (locations elided):
//
//   region loop#1 loop parent=seq#1 entered recursive label="refine"
//   region call#1 call parent=loop#1 entered label="refine"      <- NOT a strand: `refine`
//                                                                   is an ordinary function
//                                                                   that returns a promise
//   region choice#1 / branch#1                                   <- `.then` may not run
//   region loop#2 loop parent=branch#1 entered recursive label="then"
//   region call#2 call parent=loop#2 entered label="then" strand <- the continuation IS one,
//                                                                   and is itself in the
//                                                                   recursion SCC
//   issue ask#1 in=seq#1>loop#1>call#1
//   settle ask#1 in=seq#1>loop#1>call#1>choice#1>branch#1>loop#2>call#2   <- the prologue,
//                                                                   certain, ONCE
//   jump recur loop#1 in=…>call#2>choice#2>branch#2              <- round 2, and nothing else
//   settle ask#1 in=seq#1 joins=call#2
//
// Read the residual off the third-from-last line: there is exactly one prologue settle for a
// recursion the script may run any number of times. The outer `await` joins `call#2` (the
// strand spawned while its operand was evaluated), not `call#1`, and picks up the strand's
// summary — which is why ask#1 settles on the main line at all.
//
// causality — one step with a `carry` self-edge (`ask#1 -> ask#1 carry always`) and the
// `serial` cue: the rounds are the same site, one after another.
function refine(t: string): PromiseLike<string> {
  return agent("r")
    .ask<string>(t)
    .then((r) => (r.length > 40 ? refine(r) : r));
}

return await refine("start");
