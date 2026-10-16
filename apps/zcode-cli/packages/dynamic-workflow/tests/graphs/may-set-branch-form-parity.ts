// The BRANCH form of `may-set-oneshot-ternary`: `cond ? a.ask(p) : b.ask(p)` where that
// fixture writes `(cond ? a : b).ask(p)`. The two are the same program, and refactoring
// invariance is what lane expansion exists to deliver — so they must agree on certainty:
// two `maybe` steps, one per lane, with `maybe` edges into them. This fixture is the guard
// for that parity, and it is what fixes expansion's edge rule to endpoint inheritance
// re-applied rather than a preserved edge certainty.
const fast = agent("fast");
const careful = agent("careful");
const brief = await agent("triage").ask<string>("classify this request");
const answer =
  brief.length > 8
    ? await careful.ask<string>(`handle ${brief}`)
    : await fast.ask<string>(`handle ${brief}`);
return answer;
