// An ask-produced collection routed through BOTH a fan-out and a join before reaching
// a downstream consumer ask. Guards the projection's central claim ("relays drop,
// edges survive"): the site graph emits the additive direct edges (producer -> mid,
// producer -> consumer, mid -> consumer), so after dropping both relays the actor
// graph keeps producer -> mid, producer -> consumer, mid -> consumer.
const items = await agent("producer").ask<string[]>("list");
const inner = items.map((it) => agent("mid").ask<string>(`process ${it}`));
const joined = await Promise.all(inner);
const out = await agent("consumer").ask<string>(`summarize ${JSON.stringify(joined)}`);
return out;
