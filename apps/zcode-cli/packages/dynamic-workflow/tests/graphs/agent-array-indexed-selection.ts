// Agents stored in an array, selected by a static vs a computed index on the ask
// receiver. agents[0] is field-sensitive (singleton actor#1, exact); agents[i] with
// a computed index widens the receiver to the whole array {actor#1, actor#2}.
const agents = [agent("worker-a"), agent("worker-b")];
const seed = await agents[0]!.ask<string>("seed");
const i = seed.length % 2;
const out = await agents[i]!.ask<string>(`use ${seed}`);
return out;
