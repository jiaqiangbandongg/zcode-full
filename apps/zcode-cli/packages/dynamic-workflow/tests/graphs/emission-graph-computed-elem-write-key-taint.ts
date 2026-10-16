// A facade ask in the KEY position of an element-access WRITE (`o[<ask>] = v`). Runtime: ask#2's
// output becomes a KEY of `o`, so a later `for (const k in o)` enumerates that tainted key string
// ("strings launder nothing"). Required may-flow: ask#1 -> ask#2 (s into the write-key
// instructions) and ask#2 -> ask#3 (the key string, via the for-in accumulator, into ask#3's
// instructions). If the write key is skipped, ask#2 loses its sinks AND `o` never carries the
// key taint, so the for-in read drops the edge — which would also make the for-in fix unsound
// against computed writes.
const s = await agent("keeper").ask<string>("secret");
const o: Record<string, number> = {};
o[await agent("namer").ask<string>(`name using ${s}`)] = 1;
let keys = "";
for (const k in o) {
  keys += k;
}
return agent("final").ask<string>(`fields ${keys}`);
