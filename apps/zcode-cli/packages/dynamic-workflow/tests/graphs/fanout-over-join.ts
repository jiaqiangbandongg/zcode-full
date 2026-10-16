// Two relay stages composed: a fan-out feeds a join whose result feeds a second
// fan-out feeding a second join. Exercises additive relay routing across two
// map/Promise.all stages. In the actor projection both relays drop but the additive
// direct edges keep connectivity: workspace -> a, a -> b, a -> sink, b -> sink.
const paths = await files.glob("src/**/*.ts");
const first = await Promise.all(paths.map((p) => agent("a").ask<string>(p)));
const second = first.map((r) => agent("b").ask<string>(r));
const out = await Promise.all(second);
return out;
