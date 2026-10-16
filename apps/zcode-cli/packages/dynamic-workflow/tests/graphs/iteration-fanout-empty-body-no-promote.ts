// EMPTY-body candidates over tracked data: neither the forEach with an empty inline
// callback nor the empty for...of reaches a facade site, so neither may promote
// (no fan-out nodes) — and the collection's flow to the later ask must survive.
// Expected: source -> world-read#1; world-read#1 -> ask#1; ask#1 -> sink;
//           NO fan-out nodes.
const seeds = await files.glob("*.md");
seeds.forEach(() => {});
for (const _s of seeds) {
  // intentionally empty
}
return agent("summarizer").ask<string>(seeds.join(","));
