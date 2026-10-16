// Port subsumption at one sink: element 0 of a join result AND the whole tuple both
// reach the return. The portless whole-tuple read must subsume the ported element read:
// exactly ONE join#1 -> sink edge, portless, exact — plus the additive producer edges
// ask#1 -> sink and ask#2 -> sink.
const pair = await Promise.all([agent("a").ask<string>("A"), agent("b").ask<string>("B")]);
const first = pair[0];
return `${first} | ${JSON.stringify(pair)}`;
