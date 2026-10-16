// Named callback passed to .map. A fan-out candidate like an inline arrow (candidates are
// value-based: docs/analysis.md): `review` is applied per element
// with the fanned-out element, routing world-read#1 into the reviewer ask (exact) and the ask
// result out through the join to the sink; the ordering walk inlines `review` inside the
// `fanout` region and the actor carries `within=fan-out#1`.
const paths = await files.glob("src/**/*.ts");
const review = (p: string) => agent("reviewer").ask<string>(`review ${p}`);
const nodes = paths.map(review);
const results = await Promise.all(nodes);
return results;
