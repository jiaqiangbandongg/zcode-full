// A promise stored in a variable and awaited much later. Phase 1 cannot resolve which
// steps settle at `await held`, so the barrier WIDENS over everything in flight and
// the edges it produces into the following step are `maybe` (here: ask#1 -> ask#3).
// Phase 2 (await-site taint sets) resolves it exactly — an intended snapshot change.
const slow = agent("slow");
const held = slow.ask<string>("slow one");
const quick = await agent("quick").ask<string>("quick one");
const later = await held;
const summary = await agent("summarizer").ask<string>("wrap up");
return `${quick} ${later} ${summary}`;
