// Static fan-out containment (`within`, item 7). Two judge idioms in one script:
//  A) `agent("judgeA")` is created INSIDE the first fan-out body -> a lane family:
//     both the actor (actor#1) and its ask (ask#1) carry within=fan-out#1 (a fresh
//     actor per element).
//  B) `judgeB` is created OUTSIDE any fan-out and asked inside the second fan-out ->
//     the actor (actor#2) has NO within (one shared, serialized lane), while its ask
//     (ask#2) still carries within=fan-out#2 (per-element instances of the ask).
// `within` is purely lexical containment in a PROMOTED candidate's body; the two
// maps both reach an ask, so both promote (fan-out#1, fan-out#2).
const findings = await files.glob("*.log");
const a = findings.map((f) => agent("judgeA").ask<string>(`triage ${f}`));
const judgeB = agent("judgeB");
const b = findings.map((f) => judgeB.ask<string>(`triage ${f}`));
return [...a, ...b];
