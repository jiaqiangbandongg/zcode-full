// Realistic idiom: accumulate a report string across a loop of asks with `+=`, then
// summarize. The worker artifacts must reach the summarizer through the accumulator.
const inputs = ["a.ts", "b.ts", "c.ts"];
let report = "";
for (const f of inputs) {
  const r = await agent("worker").ask<string>(`analyze ${f}`);
  report += r;
}
const summary = await agent("summarizer").ask<string>(`Summarize:\n${report}`);
return summary;
