// A hole inside a fill: the inner one is open and keyed by its own name like any hole (no outer
// prefix, so ids do not grow with depth); its phase carries `fill=<outer id>` because the outer
// fill wrote it, and it stands in the outer hole's phase, which claims the body's first ask.
// No marker anywhere: the phase vocabulary comes from the holes alone.
interface Survey {
  slowest: string;
}
interface Plan {
  groups: string[][];
}
interface Order {
  first: string;
}
const survey = await agent("勘察员").ask<Survey>("列出最慢的测试文件");
const plan = await hole<Plan>("决定分组", `最慢的是 ${survey.slowest}`, async () => {
  const draft = await agent("分组员").ask<Plan>(`先按模块分组 ${survey.slowest}`);
  const order = await hole<Order>("决定顺序", `${draft.groups.length} 组，哪组先跑`);
  return { groups: [[order.first], ...draft.groups] };
});
return agent("执行者").ask<string>(`按 ${plan.groups.length} 组执行`);
