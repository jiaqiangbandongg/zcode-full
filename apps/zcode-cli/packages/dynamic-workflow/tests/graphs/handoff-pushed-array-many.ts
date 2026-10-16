// A const array literal that is later `push`ed is NOT a literal length: the analyzer must
// give no cardinality (no ` count=` on the fan-out) and the family becomes one `many` card.
// The second fan-out iterates an ask result — unknowable, also `many`.
interface Draft {
  text: string;
}
const topics = ["sky", "sea"];
topics.push("soil");
const drafts = await Promise.all(topics.map((t) => agent(`writer-${t}`).ask<Draft>(`write about ${t}`)));
const planner = agent("planner");
const more = await planner.ask<string[]>(`more topics after ${drafts.length}`);
const extra = await Promise.all(more.map((t) => agent(`writer-${t}`).ask<Draft>(`write about ${t}`)));
return [...drafts, ...extra];
