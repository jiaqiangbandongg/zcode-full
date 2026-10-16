// Actor label through a Map: both asks run on the SAME actor at runtime (the map
// stores and returns the writer), so the asks are context-related.
// Expected: ask#1 actors include actor#1; context edge ask#1 -. ask#2; ask#1 ->
// ask#2 data (`one` in ask#2's instructions); ask#2 -> sink.
const writer = agent("writer");
const m = new Map<string, Agent>();
m.set("w", writer);
const got = m.get("w")!;
const one = await got.ask<string>("draft");
const two = await writer.ask<string>(`review ${one}`);
return two;
