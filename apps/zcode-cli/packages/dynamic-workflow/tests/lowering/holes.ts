// Holes lower to `__host.hole(siteId, name, prompt ?? void 0, (__src) => eval(__src), body?)`
// (execution-engine.md, "lowering" rows for hole): the evaluator is emitted AT THE SITE so its
// direct eval runs in the hole's lexical scope; a filled hole passes its lowered body as the
// fifth argument and the same body comes back as text in `holeBodies`. Body sites carry the
// hole's own `hole#<hash>/` prefix; the outer ids are the ones a script without the body has.
interface Survey {
  slowest: string;
}
interface Plan {
  groups: string[][];
}
interface Verdict {
  pass: boolean;
}
const survey = await agent("勘察员").ask<Survey>("列出最慢的测试文件");
const plan = await hole<Plan>("决定分组", `最慢的是 ${survey.slowest}`, async () => {
  phase("分组");
  const draft = await agent("分组员").ask<Plan>(`按模块分组 ${survey.slowest}`);
  report({ groups: draft.groups.length });
  return draft;
});
const order = await hole<string>("决定顺序");
const done = await agent("执行者").ask<string>(`按 ${plan.groups.length} 组执行，先跑 ${order}`);
return await hole<Verdict>("评判", `执行结果：${done}`);
