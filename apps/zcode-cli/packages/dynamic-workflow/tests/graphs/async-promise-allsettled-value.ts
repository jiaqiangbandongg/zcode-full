// Promise.allSettled: field-sensitive access through the settled records
// (.value on the fulfilled arm, .reason on the rejected arm) must keep the flow.
// Expected: ask#1 -> join#1 port=0; ask#2 -> join#1 port=1;
//   join#1 -> ask#3 port=0 and port=1; ask#1 -> ask#3; ask#2 -> ask#3 (additive);
//   ask#3 -> sink.
const results = await Promise.allSettled([
  agent("alpha").ask<string>("a"),
  agent("beta").ask<string>("b"),
]);
const r0 = results[0];
const first = r0.status === "fulfilled" ? r0.value : String(r0.reason);
const r1 = results[1];
const second = r1.status === "fulfilled" ? r1.value : "";
return agent("merger").ask<string>(`merge ${first} ${second}`);
