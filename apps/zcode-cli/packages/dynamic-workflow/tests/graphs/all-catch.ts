// .catch on a real Promise (Promise.all returns Promise<string[]>). Runtime: if any
// ask rejects, fallback runs and its result becomes the awaited value. The keystone
// rule must let the fallback ask reach the return sink.
const a = agent("a").ask<string>("x");
const b = agent("b").ask<string>("y");
const r = await Promise.all([a, b]).catch(() => agent("fallback").ask<string>("recover"));
return r;
