// Compound assignment: `report += a` must write a's taint back into report so the
// downstream ask that reads report depends on it.
const a = await agent("alpha").ask<string>("start");
let report = "intro";
report += a;
const b = await agent("beta").ask<string>(`Report: ${report}`);
return b;
