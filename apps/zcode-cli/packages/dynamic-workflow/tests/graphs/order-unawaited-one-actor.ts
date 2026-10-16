// Two un-awaited asks on ONE actor, joined at the end: the `Promise.all` does NOT
// parallelize them, because the actor's mailbox serializes them. Expect a `fifo` edge
// ask#1 -> ask#2 — an arrow where the script suggests concurrency.
const critic = agent("critic");
const p1 = critic.ask<string>("assess A");
const p2 = critic.ask<string>("assess B");
const [a, b] = await Promise.all([p1, p2]);
return `${a} ${b}`;
