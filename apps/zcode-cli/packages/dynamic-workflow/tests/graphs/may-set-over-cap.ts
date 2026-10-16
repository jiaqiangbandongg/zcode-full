// A may-set past the expansion cap: an array of FIVE agents indexed by a computed index
// widens the receiver to all five. Over the cap the step keeps the single card in
// `lanes[0]`, byte-identical to pre-expansion behaviour — a capped may-set falls back
// rather than truncating, because dropping candidates would be a claim the analysis
// cannot make while five copies would multiply steps and edges past what a reader (and
// the payload) can carry.
const pool = [agent("w0"), agent("w1"), agent("w2"), agent("w3"), agent("w4")];
const seed = await agent("seed").ask<string>("pick a worker");
const picked = pool[seed.length]!;
const out = await picked.ask<string>(`go ${seed}`);
return out;
