// A dynamically selected receiver inside a phase: the may-set copies land on two cards
// (one per candidate lane), each holding its copy of the ask; the same-lane loop back edge
// dissolves, the workspace → either card hand-off survives with the read's type.
const fast = agent("fast");
const slow = agent("slow");
phase("triage");
const logs = await files.glob("*.log");
let verdicts: string[] = [];
for (const f of logs) {
  const who = f.endsWith(".big.log") ? slow : fast;
  verdicts = [...verdicts, await who.ask<string>(`triage ${f}`)];
}
return verdicts;
