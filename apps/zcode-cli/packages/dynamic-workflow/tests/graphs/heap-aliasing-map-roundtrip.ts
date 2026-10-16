// Map.get after Map.set of a tracked box, with the taint written AFTER the set:
// the unknown `get` call's receiver collapse must carry the box's (later) taint.
// Expected: ask#1 -> ask#2 data; ask#2 -> sink.
const box: { f: string } = { f: "" };
const m = new Map<string, { f: string }>();
m.set("k", box);
box.f = await agent("writer").ask<string>("secret");
const got = m.get("k");
return agent("reader").ask<string>(`use ${got?.f ?? ""}`);
