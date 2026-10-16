// A callee selected by a COMPUTED index (`fns[i]`) must still dispatch to the tracked
// arrow's summary: collapse carries function values through the widening, so this is a
// resolved (widened, inexact) call, NOT an unknown call. `i` is const 0, so at runtime
// the array's sole arrow is invoked with secret, whose ask reads it.
// Expected: source -> ask#1 exact, ask#1 -> ask#2 INEXACT (computed-index widening clears
// exactness); the call result is discarded so there is no ask#2 -> sink (return literal).
const secret = await agent("s").ask<string>("secret");
const fns = [(x: string) => agent("j").ask<string>(`judge ${x}`)];
const i = 0;
fns[i]!(secret);
return "done";
