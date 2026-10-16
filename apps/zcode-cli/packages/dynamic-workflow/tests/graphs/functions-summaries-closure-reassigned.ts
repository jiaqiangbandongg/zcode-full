// A closure captures `topic`, which is reassigned to a tainted value AFTER the
// closure is defined; the closure runs again after the reassignment. Runtime flow:
// ask#2 result -> topic -> ask#1 instructions. Flow-insensitivity must produce
// ask#2 -> ask#1 (the single env slot unions the reassignment).
const judge = agent("judge");
let topic = "seed";
const go = () => judge.ask<string>(`judge ${topic}`);
await go();
topic = await agent("t").ask<string>("new topic");
const second = await go();
return second;
