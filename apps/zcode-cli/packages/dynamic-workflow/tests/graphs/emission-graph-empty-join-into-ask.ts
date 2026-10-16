// Promise.all([]) — a join with NO inputs — consumed by an ask. The join carries its
// own label, so join#1 -> ask#1 is emitted, the join is NOT pruned (it has an edge),
// and the ask gets NO source-completion edge (it has incoming data). In the actor
// projection the join drops and contributes no replacement edge (it has no producers),
// so the "solo" actor renders with no in-edge at all.
const nothing = await Promise.all([]);
return agent("solo").ask<string>(`start ${JSON.stringify(nothing)}`);
