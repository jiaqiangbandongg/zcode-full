// Executor reject param: `new Promise((_, reject) => reject(secret))`. The generic
// keystone-for-`new` rule captures whatever a function arg feeds to invocations of its OWN
// params, for EVERY param — so the reject param (index 1) is covered like resolve (index 0).
// Awaiting a rejected promise throws, so putting reject's arg into the resolved-value pot is a
// deliberate over-approximation of the rejection path (sound: an added may-flow, never a drop).
// Expected: ask#1 -> ask#2 data; ask#2 -> sink.
const secret = agent("scanner").ask<string>("scan");
const p = new Promise<string>((_resolve, reject) => {
  reject(secret);
});
const v = await p;
return agent("writer").ask<string>(`report: ${v}`);
