// Context edges over MAY-set receivers: ask#2 runs on {alpha,beta}, ask#3 on
// {beta,gamma}. Sets intersect (beta) -> context edge ask#2 -> ask#3, INEXACT (not the
// same singleton); ask#1 ({alpha}) relates to ask#2 (intersect alpha, inexact) but NOT
// to ask#3 (disjoint). Direction is source order. In the actor projection each may-ask
// fans out inexactly to every candidate lane.
const a = agent("alpha");
const b = agent("beta");
const c = agent("gamma");
const seed = await a.ask<string>("seed");
const one = await (seed.length > 2 ? a : b).ask<string>(`step one ${seed}`);
const two = await (one.length > 2 ? b : c).ask<string>(`step two ${one}`);
return two;
