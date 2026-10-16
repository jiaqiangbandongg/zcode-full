// A one-shot ternary receiver at the top level: nothing guards the ask, so the source
// step is `always`. Each copy is nonetheless `maybe` — the ask always runs, but each copy
// may not, and certainty is per-node. No enclosing iteration region, so no carry edge.
const fast = agent("fast");
const careful = agent("careful");
const brief = await agent("triage").ask<string>("classify this request");
const answer = await (brief.length > 8 ? careful : fast).ask<string>(`handle ${brief}`);
return answer;
