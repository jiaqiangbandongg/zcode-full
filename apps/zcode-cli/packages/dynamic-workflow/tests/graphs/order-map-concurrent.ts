// The motivating pair, half A: `Promise.all` over a `.map`. N instances COEXIST, so
// the ask is repeat=stack with no self-arrow. Byte-compare against
// order-forof-sequential.causality.txt: same lanes, same data edge, opposite cue.
const paths = await files.glob("src/**/*.ts");
const verdicts = await Promise.all(paths.map((p) => agent("reviewer").ask<string>(`review ${p}`)));
return verdicts;
