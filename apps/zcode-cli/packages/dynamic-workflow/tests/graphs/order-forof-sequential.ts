// The motivating pair, half B: `for…of` with an inner `await`. Strictly SEQUENTIAL —
// iteration k's ask settles before k+1 is issued. Must differ from its
// `Promise.all(map)` twin (order-map-concurrent.ts) in the CUE, not just the edges:
// this one gets a self-arrow (`carry` ask#1 -> ask#1, repeat=serial) and NO stack.
const paths = await files.glob("src/**/*.ts");
const verdicts: string[] = [];
for (const p of paths) {
  verdicts.push(await agent("reviewer").ask<string>(`review ${p}`));
}
return verdicts;
