// A filled hole without markers: the hole's own phase holds the fill's ask (`<hole id>/ask#1`),
// named after the hole and standing between the two outer phases; the body's `return` is a
// return from the hole, not a top-level return. The hole id is the key of its name.
interface Verdict {
  pass: boolean;
}
phase("审阅");
const findings = await agent("审阅者").ask<string>("审阅改动");
const verdict = await hole<Verdict>("评判", `审阅结果：${findings}`, async () => {
  return await agent("裁判").ask<Verdict>(`据此裁定：${findings}`);
});
phase("收尾");
return agent("记录员").ask<string>(`记录 ${verdict.pass ? "通过" : "退回"}`);
