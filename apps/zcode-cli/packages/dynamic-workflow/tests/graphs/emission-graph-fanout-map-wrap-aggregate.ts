// Root cause 8, integration: a two-stage fan-out where the second stage's per-item map
// wraps the awaited critic ask in a SHORTHAND object literal (`{ idea, critique }`), a judge
// aggregates the wrapped entries, and the script returns `{ entries, verdict }` (both
// shorthands). The wrap dropped every critic label, so the critic ask reached neither the
// join nor the judge, and the returned `entries` never reached the sink. With the fix the
// wrapped labels survive both the join relay and the return.
// Expected: critic ask#2 -> join#2 and ask#2 -> ask#3(judge); judge ask#3 -> sink;
// join#2 -> sink (the returned entries carry the aggregated critiques).
const personas = ["dreamer", "engineer"];
const ideas = await Promise.all(
  personas.map((p) => agent(`inventor-${p}`).ask<string>(`pitch for ${p}`)),
);
const entries = await Promise.all(
  ideas.map(async (idea, i) => {
    const critic = agent(`critic-${i}`);
    const critique = await critic.ask<string>(`critique ${idea}`);
    return { idea, critique };
  }),
);
const verdict = await agent("judge").ask<string>(
  `crown a winner: ${entries.map((e) => e.critique).join(", ")}`,
);
return { entries, verdict };
