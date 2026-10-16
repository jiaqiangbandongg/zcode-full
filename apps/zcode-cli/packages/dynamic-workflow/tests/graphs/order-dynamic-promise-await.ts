// `await` of a dynamically-selected promise: the awaited expression is a ternary over
// two pending asks and issues nothing, so the barrier widens over BOTH. Over-ordering
// is the honest direction — it understates parallelism, never invents it. Both widened
// edges into the trailing step carry `maybe`.
const topic = "which side";
const left = agent("left").ask<string>("L");
const right = agent("right").ask<string>("R");
const pick = topic.length > 3 ? left : right;
const chosen = await pick;
const summary = await agent("summarizer").ask<string>("wrap up");
return `${chosen} ${summary}`;
