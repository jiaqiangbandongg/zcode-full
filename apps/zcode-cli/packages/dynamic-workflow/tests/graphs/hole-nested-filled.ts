// Both holes filled: the outer fill wrote `<outer>/…`, the inner fill wrote `<inner>/…` (one
// prefix level each: hole ids are name keys). The outer hole's phase claims the outer body's
// first ask; the inner hole's phase claims nothing (its body opens with a marker) but keeps its
// place and carries `fill=<outer>`, and the marker phase inside it carries `fill=<inner>`.
// Neither hole is a step any more, and `holes` is absent from the display.
interface Survey {
  slowest: string;
}
interface Plan {
  groups: string[][];
}
interface Order {
  first: string;
}
phase("摸底");
const survey = await agent("勘察员").ask<Survey>("列出最慢的测试文件");
const plan = await hole<Plan>("决定分组", `最慢的是 ${survey.slowest}`, async () => {
  const draft = await agent("分组员").ask<Plan>(`先按模块分组 ${survey.slowest}`);
  const order = await hole<Order>("决定顺序", `${draft.groups.length} 组，哪组先跑`, async () => {
    phase("排序");
    return await agent("排序员").ask<Order>(`给 ${draft.groups.length} 组排序`);
  });
  return { groups: [[order.first], ...draft.groups] };
});
phase("执行");
return agent("执行者").ask<string>(`按 ${plan.groups.length} 组执行`);
