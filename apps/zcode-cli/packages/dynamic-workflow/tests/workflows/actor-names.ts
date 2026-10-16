// Actor naming: every legal shape under the "named actors must be unique" rule
// (docs/execution-engine.md). This file must compile clean — it is the
// false-positive guard for the duplicate-name diagnostic (9005), whose violations are
// asserted in tests/actor-names.test.ts (the fixture suite here only typechecks).
//
// Distinct literal names, any number of anonymous actors, and dynamic names built in a
// loop are all fine. Uniqueness of the dynamic ones is checked at run time by the
// engine's createActor — a name only a running script knows cannot be checked here.
const planner = agent("planner");
const reviewer = agent("reviewer", { system: "You review." });
const judge = agent("judge", { system: "You judge." });

// Anonymous actors are legal in any number: the display label is the binding name, and
// the price of staying anonymous is having no cache identity for a future amended re-run.
const scratch = agent();
const helper = agent();

const plan = await planner.ask<string>("Draft a plan.");
const review = await reviewer.ask<string>(`Review this plan:\n${plan}`);
const verdict = await judge.ask<string>(`Ship it?\n${review}`);
log(await scratch.ask<string>("Anything odd about this?"));
log(await helper.ask<string>("Anything else?"));

// Per-item workers: one site, many actors, names only the run knows.
const items = ["a", "b", "c"];
const notes: string[] = [];
for (const item of items) {
  const worker = agent(`worker-${item}`, "You handle one item.");
  notes.push(await worker.ask<string>(`Handle ${item}.`));
}

return { verdict, notes };
