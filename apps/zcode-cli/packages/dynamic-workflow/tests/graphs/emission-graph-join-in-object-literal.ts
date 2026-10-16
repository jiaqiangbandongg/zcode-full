// Two joins grouped in ONE object literal, their results read downstream. Regression guard
// for resolvePlace's gating contract: literals.ts `fieldValue` is
// `resolvePlace(expr) ?? evalExpr(expr, ctx)`, so a join that resolves as a place BEFORE it
// has ever been evaluated short-circuits `evalExpr` — handleJoin never runs, and the join
// site, its in/out edges and its markFacade all disappear. resolvePlace therefore gates the
// join case on the `joinResults` registry (which handleJoin populates), never on the site
// table.
// Expected: both joins present; ask#1/#2 -> join#1 ports 0/1, ask#3 -> join#2 port 0;
// both joins AND all three producers reach the reviewer (additive relay); reviewer -> sink.
const a = agent("analyst");
const b = agent("builder");
const groups = {
  docs: Promise.all([a.ask<string>("read docs"), a.ask<string>("read specs")]),
  code: Promise.all([b.ask<string>("read code")]),
};
const docs = await groups.docs;
const code = await groups.code;
return agent("reviewer").ask<string>(`${docs.join()} ${code.join()}`);
