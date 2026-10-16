// The structural blast radius of emission-graph-join-in-object-literal, one level up: a
// `.map` whose callback's only facade sites sit inside a join nested in an object literal.
// When `fieldValue` short-circuits `evalExpr` for the join call, the WHOLE subtree goes
// unevaluated — the join and the ask inside its array literal alike — so markFacade never
// fires and the iteration candidate never promotes. What vanishes is the fan-out NODE
// itself, not merely an edge.
// Expected: fan-out#1 promoted, with `within=fan-out#1` on both the join and the ask;
// ask#1 -> join#1 port=0; fan-out#1, join#1 and ask#1 all reach the reader; reader -> sink.
const items = ["a", "b", "c"];
const a = agent("a");
const outer = items.map((item) => ({ pending: Promise.all([a.ask<string>(`work ${item}`)]) }));
const first = await outer[0]!.pending;
return agent("reader").ask<string>(`${first[0]}`);
