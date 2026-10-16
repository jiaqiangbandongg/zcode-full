// Unknown array calls in a chain before a fan-out: .flat() on a nested tracked array
// and .filter(Boolean) (named callback, non-candidate) must both preserve flow; the
// final map promotes.
// Expected: source -> ask#1, source -> ask#2; ask#1/ask#2 -> fan-out#1;
//           ask#1/ask#2 -> ask#3; fan-out#1 -> ask#3; ask#1/ask#2/fan-out#1/ask#3 -> sink.
const a = await agent("a").ask<string>("one");
const b = await agent("b").ask<string>("two");
const nested = [[a], [b]];
const flatv = nested.flat();
const hits = flatv.filter(Boolean);
const outs = hits.map((h) => agent("judge").ask<string>(h));
return outs;
