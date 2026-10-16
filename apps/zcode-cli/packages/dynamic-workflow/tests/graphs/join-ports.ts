// Promise.all over a static array literal: element positions become ports. One
// element (x = element 0) feeds a downstream ask; the other (y = element 1) reaches
// the sink. Additive relay: the join label AND the underlying producer both flow.
// Expected:
//   ask#1 -> join#1 port=0, ask#2 -> join#1 port=1   (join in-taints)
//   join#1 -> ask#3 port=0, ask#1 -> ask#3           (x into ask#3; additive)
//   join#1 -> sink port=1, ask#2 -> sink             (y into return; additive)
//   ask#3 -> sink                                     (z into return)
const [x, y] = await Promise.all([
  agent("first").ask<string>("A"),
  agent("second").ask<string>("B"),
]);
const z = await agent("third").ask<string>(`use ${x}`);
return `${y} ${z}`;
