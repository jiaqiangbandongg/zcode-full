// Double await of one Node: both awaits settle to the SAME object at runtime, so a
// mutation between them (push of the critic's output) is visible via the second await.
// Expected: ask#1 -> ask#3 data; ask#2 -> ask#3 data; ask#3 -> sink.
const plan = agent("planner").ask<{ steps: string[] }>("plan the work");
const first = await plan;
const extra = await agent("critic").ask<string>("one more step");
first.steps.push(extra);
const second = await plan;
return agent("executor").ask<string>(`do: ${second.steps.join("; ")}`);
