// Root cause 8: a tainted value wrapped in a SHORTHAND object-literal property at the
// script return. The wrap stores the referenced local's value symbol (not the object's
// property symbol), so the ask label survives into the returned artifact and reaches the
// virtual sink. `shallow` proves the top-level wrap; `box: { deep }` proves a nested
// shorthand at depth 2 folds the same way. Before the fix both were dropped (the shorthand
// resolved a fresh empty property slot), leaving the asks with no path to the sink.
// Expected: source -> ask#1, source -> ask#2, ask#1 -> sink, ask#2 -> sink.
const shallow = await agent("planner").ask<string>("go");
const deep = await agent("nested").ask<string>("go again");
return { shallow, box: { deep } };
