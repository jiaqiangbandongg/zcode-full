// Root cause 8: an async map callback wraps its awaited ask in a SHORTHAND object literal
// (`return { critique }`) before the Promise.all join. The wrap dropped the critic ask's
// label (shorthand resolved an empty property slot), so the ask had ZERO outgoing edges:
// nothing reached the join, the downstream aggregator, or the sink. With the fix the field
// aliases the local's value, so the label flows through the join relay as usual.
// Expected: fan-out#1 -> ask#1(critic), ask#1 -> join#1, join#1 -> ask#2(final),
// ask#1 -> ask#2 (additive relay), ask#2 -> sink.
const xs = ["a", "b"];
const outs = await Promise.all(
  xs.map(async (x) => {
    const critic = agent(`critic-${x}`);
    const critique = await critic.ask<string>(`judge ${x}`);
    return { critique };
  }),
);
const parts = outs.map((o) => o.critique);
return agent("final").ask<string>(`use ${parts.join(",")}`);
