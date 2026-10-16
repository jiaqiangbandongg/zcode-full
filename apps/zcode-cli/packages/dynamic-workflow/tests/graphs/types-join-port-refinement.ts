// Join port refinement + actor-edge type aggregation (docs/analysis.md,
// "Edge attributes"). A Promise.all over a STATIC ARRAY LITERAL of
// two asks with DIFFERENT artifact types gives the join per-element (port) types. The
// result is destructured, and each element flows onward into one consumer ask, so the
// join's outgoing edges are port-refined to the element types (not the whole tuple).
//
// Both producer asks are the SAME actor (worker), so in the derived actor graph their
// two additive producer edges collapse into ONE worker -> consumer edge that aggregates
// two distinct message types.
// Expected:
//   join#1 -> ask#3 port=0 type="Draft", join#1 -> ask#3 port=1 type="Verdict"
//   actor edge worker -> consumer types="Draft","Verdict"
interface Draft {
  body: string;
}

interface Verdict {
  approved: boolean;
}

const worker = agent("worker");
const [x, y] = await Promise.all([
  worker.ask<Draft>("Write a draft"),
  worker.ask<Verdict>("Judge the draft"),
]);
const z = await agent("consumer").ask<string>(`draft ${x.body} verdict ${y.approved}`);
return z;
