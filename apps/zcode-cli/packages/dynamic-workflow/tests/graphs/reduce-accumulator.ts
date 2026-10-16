// reduce chaining through the accumulator (fix #3): each iteration asks with the
// running accumulator interpolated into the instructions. The accumulator carries
// the PRIOR iteration's ask result, so the ask's own artifact flows back into its
// own instructions across iterations -> a data SELF-edge ask#1 -> ask#1. Before the
// fix the accumulator param never received the callback's return taint (the per-pass
// callbackReturn was fresh at bind time), so the ask -> ask chain was dropped. The
// reduce body reaches an ask, so the candidate also promotes to a fan-out.
//
// Expected edges:
//   source -> world-read#1                     (items drive the loop)
//   world-read#1 -> fan-out#1                   (iterated collection into the fan-out)
//   world-read#1 -> ask#1, fan-out#1 -> ask#1   (the item element into the ask)
//   ask#1 -> ask#1                              (accumulator self-chain)
//   world-read#1 -> sink, fan-out#1 -> sink, ask#1 -> sink  (summary reaches return)
const items = await files.glob("*.md");
const summary = await items.reduce(
  async (acc, item) => agent("summarizer").ask<string>(`${await acc} then ${item}`),
  Promise.resolve(""),
);
return summary;
