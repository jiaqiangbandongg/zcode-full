// Array.from(xs, mapper): a per-element callback per the registry (`each`, iterated = arg 0,
// callback = arg 1), so a fan-out candidate exactly like `xs.map(mapper)`: world-read#1 routes
// into the reviewer ask through the fan-out, and the mapper body is a `fanout` region.
const paths = await files.glob("src/**/*.ts");
const nodes = Array.from(paths, (p) => agent("reviewer").ask<string>(`review ${p}`));
const results = await Promise.all(nodes);
return results;
