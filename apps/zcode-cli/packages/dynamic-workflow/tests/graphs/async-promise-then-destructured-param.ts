// .then callback with a DESTRUCTURED parameter over a join result: at runtime
// x is alpha's output and y is beta's output, both feeding the merger ask.
// Expected: ask#1 -> join#1 port=0; ask#2 -> join#1 port=1;
//   ask#1 -> ask#3; ask#2 -> ask#3; join#1 -> ask#3; ask#3 -> sink.
const pair = Promise.all([
  agent("alpha").ask<string>("a"),
  agent("beta").ask<string>("b"),
]);
const combined = await pair.then(([x, y]) => agent("merger").ask<string>(`merge ${x} and ${y}`));
return combined;
