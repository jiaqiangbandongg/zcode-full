// Actor names the script INTERPOLATES: `agent()` gets a template literal, so the
// literal test in `actorName` misses and the lane would read "Anonymous Agent" even
// though the script plainly said something. The analysis extracts the template's static
// affixes instead — see docs/analysis.md, "Labels and names".
//
// Every receiver here is INLINE on purpose. `actorName` falls back to the binding name
// when the call initializes a `const`, which is a real name and must keep winning; only
// an inline receiver leaves the pattern as the sole thing available. Inline is also the
// one shape `askLabel` answers "ask" for (a receiver that is neither literal nor
// identifier), so each step pins `label-head=`/`label-tail=` alongside the lane's.
//
// All five outcomes in one fixture, in lane order:
//   actor#1  head only          `研究员${i + 1}`     -> head="研究员"
//   actor#2  tail only          `${role}-worker`     -> tail="-worker"
//   actor#3  head and tail      `a${x}b`             -> head="a", tail="b"
//   actor#4  middle dropped     `pre${x}mid${y}post` -> head="pre", tail="post"
//   actor#5  affix trims away   `   ${x}`            -> no pattern at all
//   actor#6  punctuation only   `${x}-`              -> no pattern (`…-` is worse
//                               than the anonymous fallback)
const role = "night";
const x = 1;
const y = 2;

const drafts = await Promise.all(
  [1, 2, 3].map((i) => agent(`研究员${i + 1}`).ask<string>(`draft section ${i}`)),
);

const a = await agent(`${role}-worker`).ask<string>(`take the night shift: ${drafts.join()}`);
const b = await agent(`a${x}b`).ask<string>(`wrap ${a}`);
const c = await agent(`pre${x}mid${y}post`).ask<string>(`extend ${b}`);
const d = await agent(`   ${x}`).ask<string>(`review ${c}`);
const e = await agent(`${x}-`).ask<string>(`sign off on ${d}`);

return e;
