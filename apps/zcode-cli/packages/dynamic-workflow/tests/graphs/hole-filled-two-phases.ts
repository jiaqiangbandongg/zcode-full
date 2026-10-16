// A filled hole whose body opens with a marker: the hole's own phase claims no step, yet it
// keeps its place in the control-flow phase table through its mark node; the body's two
// phases follow it carrying `fill=<hole id>`, every site the fill wrote is `<hole id>/…`, and
// the outer ids are untouched. The body is an async arrow: a strand the outer `await` joins.
interface Survey {
  slowest: string;
}
interface Smoke {
  failed: string[];
}
interface Plan {
  groups: string[][];
}
phase("摸底");
const survey = await agent("勘察员").ask<Survey>("列出最慢的测试文件");
const plan = await hole<Plan>("决定分组", `最慢的是 ${survey.slowest}`, async () => {
  phase("冒烟测试");
  const smoke = await agent("烟测员").ask<Smoke>(`只跑一遍 ${survey.slowest} 里的用例`);
  phase("分组");
  return await agent("分组员").ask<Plan>(`按模块分组，先排 ${smoke.failed.length} 个已失败用例`);
});
phase("执行");
return agent("执行者").ask<string>(`按 ${plan.groups.length} 组执行`);
