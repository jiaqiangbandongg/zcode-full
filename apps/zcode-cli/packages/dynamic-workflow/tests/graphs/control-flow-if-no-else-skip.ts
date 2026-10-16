// A skippable choice vs an exhaustive one. The first `if` has no else, so its head has a
// `branch` edge straight to the step after it; the second has an else, so control must pass
// through one of its arms and there is no skip edge.
const scan = await agent("scanner").ask<string>("scan");
if (scan.includes("todo")) {
  await agent("fixer").ask<string>(`fix todos in ${scan}`);
}
let verdict: string;
if (scan.includes("risky")) {
  verdict = await agent("auditor").ask<string>(`audit ${scan}`);
} else {
  verdict = await agent("approver").ask<string>(`approve ${scan}`);
}
return verdict;
