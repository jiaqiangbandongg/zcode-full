// A facade ask in the CONDITION position of a conditional expression. Runtime: ask#1's
// output (s) is interpolated into ask#2's instructions, so ask#1 -> ask#2 is a required
// may-flow edge; ask#2 also runs on the "judge" lane. If the evaluator never visits the
// condition, ask#2 loses its instruction and receiver sinks: no ask#1 -> ask#2 edge, a
// bogus source -> ask#2 completion, and an empty actor set on ask#2.
const s = await agent("keeper").ask<string>("secret");
const t = (await agent("judge").ask<boolean>(`safe? ${s}`)) ? "yes" : "no";
return agent("final").ask<string>(`verdict ${t}`);
