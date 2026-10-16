// An open hole between two phases (docs/analysis.md, "Sites", Hole sites): a step of kind
// `hole` issued in the phase it stands in, a memberless phase of its own in the control-flow
// phase table (so the rail can draw its station ahead of the run), its prompt a taint sink —
// `survey` flows into it — and its result a value of type Plan from outside the run, in the
// main agent's lane, flowing on into the executor.
interface Survey {
  slowest: string;
  count: number;
}
interface Plan {
  groups: string[][];
}
phase("摸底");
const survey = await agent("勘察员").ask<Survey>("列出最慢的测试文件");
const plan = await hole<Plan>("决定分组", `最慢的是 ${survey.slowest}，共 ${survey.count} 个文件；决定怎么分组`);
phase("执行");
const done = await agent("执行者").ask<string>(`按 ${plan.groups.length} 组执行`);
return done;
