// flatMap with an inline callback returning an array literal of two asks per element.
// Both asks are placed within=fan-out#1, both receive the element, and both flow to
// the join and the sink.
const paths = await files.glob("src/**/*.ts");
const nodes = paths.flatMap((p) => [
  agent("a").ask<string>(`summarize ${p}`),
  agent("b").ask<string>(`lint ${p}`),
]);
const out = await Promise.all(nodes);
return out;
