const survey = await __host.ask("ask#1", __host.createActor("actor#1", "勘察员"), "列出最慢的测试文件");
const plan = await __host.hole("hole#21b40fca", "决定分组", `最慢的是 ${survey.slowest}`, __src => eval(__src), async () => {
    __host.enterPhase("\u5206\u7EC4");
    const draft = await __host.ask("hole#21b40fca/ask#1", __host.createActor("hole#21b40fca/actor#1", "分组员"), `按模块分组 ${survey.slowest}`);
    __host.report("hole#21b40fca/report#1", { groups: draft.groups.length });
    return draft;
});
const order = await __host.hole("hole#7c7fc07b", "决定顺序", void 0, __src => eval(__src));
const done = await __host.ask("ask#2", __host.createActor("actor#2", "执行者"), `按 ${plan.groups.length} 组执行，先跑 ${order}`);
return await __host.hole("hole#cd7e8315", "评判", `执行结果：${done}`, __src => eval(__src));
