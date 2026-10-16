// A facade ask in a COMPUTED PROPERTY NAME position. Runtime: ask#1's output (s) is
// interpolated into ask#2's instructions, and ask#2's output becomes a key of `o`,
// which flows through Object.keys into ask#3's instructions. Required may-flow:
// ask#1 -> ask#2 and ask#2 -> ask#3. If the evaluator skips computed names, ask#2
// loses its instruction/receiver sinks and its output taint never enters `o`.
const s = await agent("keeper").ask<string>("secret");
const o = { [await agent("namer").ask<string>(`name for ${s}`)]: 1 };
return agent("final").ask<string>(`fields ${Object.keys(o).join(",")}`);
