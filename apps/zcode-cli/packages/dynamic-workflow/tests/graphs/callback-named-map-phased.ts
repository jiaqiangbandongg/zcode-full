// Callback invocation family: a NAMED callback to `.map` inside a phase. The value-based
// candidate applies `review` per element, so its ask sits in phase#1's `fanout` region as an
// inlined `call`, carries `within=fan-out#1`, and the summarizer in phase#2 comes after it —
// not before it, which is what the old end-of-walk sweep claimed.
phase("scan");
const paths = await files.glob("src/**/*.ts");
const review = (p: string) => agent("reviewer").ask<string>(`review ${p}`);
const out = await Promise.all(paths.map(review));
phase("report");
const s = await agent("summarizer").ask<string>(`summarize ${JSON.stringify(out)}`);
return s;
