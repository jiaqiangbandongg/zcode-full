// A facade ask in a COMPUTED METHOD NAME of an object literal (`{ [<ask>]() {…} }`). Runtime:
// ask#1's output (s) is interpolated into ask#2's instructions (the method-name expression), so
// ask#1 -> ask#2 is a required may-flow edge and ask#2 runs on the "namer" lane; the resulting
// name becomes a KEY of `o`, so ask#2 -> ask#3 via `Object.keys(o)` ("strings launder nothing").
// If the evaluator skips computed method/accessor names, ask#2 loses its sinks and `o` never
// carries the key taint.
const s = await agent("keeper").ask<string>("secret");
const o = {
  [await agent("namer").ask<string>(`method name for ${s}`)]() {
    return 1;
  },
};
return agent("final").ask<string>(`built ${Object.keys(o).join(",")}`);
