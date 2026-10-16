// Nested joins: an outer `Promise.all` whose ELEMENTS are themselves `Promise.all`
// calls, destructured into per-group tuples. Divergence repro: handleJoin used to mint a
// fresh result value each pass, so the outer element's `mayAlias` set — which dedups by
// slot IDENTITY — received a never-before-seen inner-join object every pass and the
// fixpoint ran to ITERATION_CAP. Join results are now canonical per call site.
// Expected:
//   ask#1/#2 -> join#2 ports 0/1, ask#3 -> join#3 port 0    (inner joins' in-taints)
//   join#2 -> join#1 port=0, join#3 -> join#1 port=1        (inner joins into the outer)
//   the destructured reads reach the sink through both relay labels and the asks (additive)
const a = agent("a");
const b = agent("b");
const [gates, reviews] = await Promise.all([
  Promise.all([a.ask<string>("gate one"), a.ask<string>("gate two")]),
  Promise.all([b.ask<string>("review")]),
]);
return `${gates[0]} ${gates[1]} ${reviews[0]}`;
