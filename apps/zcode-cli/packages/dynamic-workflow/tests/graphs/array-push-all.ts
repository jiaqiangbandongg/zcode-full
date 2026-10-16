// Heap mutator (Array.push) accumulating Nodes into an array, then a NON-literal
// (portless) Promise.all over that array, then a downstream aggregator. Confirms
// taint survives push and portless join routing: a -> join, b -> join, join -> c,
// plus the additive direct edges a -> c and b -> c, then c -> sink.
const arr: Node<string>[] = [];
arr.push(agent("a").ask<string>("x"));
arr.push(agent("b").ask<string>("y"));
const all = await Promise.all(arr);
const c = await agent("c").ask<string>(`merge ${all.join(" ")}`);
return c;
