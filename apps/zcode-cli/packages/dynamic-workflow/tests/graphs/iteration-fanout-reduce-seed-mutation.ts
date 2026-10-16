// reduce with an OBJECT accumulator mutated in place: at runtime the accumulator IS
// the seed object (passed as the initial value), so acc.items.push(item) fills
// seed.items with the glob results. The later ask over seed.items must see them.
// Expected: source -> world-read#1; world-read#1 -> ask#1 (MUST); ask#1 -> sink.
const items = await files.glob("*.md");
const seed = { items: [] as string[] };
items.reduce((acc, item) => {
  acc.items.push(item);
  return acc;
}, seed);
return agent("summarizer").ask<string>(seed.items.join(","));
