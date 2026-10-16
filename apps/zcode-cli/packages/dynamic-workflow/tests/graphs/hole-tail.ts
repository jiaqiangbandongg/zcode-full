// The tail form `return await hole<T>(...)`: the script's end is open. The site carries `tail`,
// the hole feeds the sink, and — with no marker anywhere — the hole is the script's only phase.
interface Verdict {
  pass: boolean;
}
const findings = await agent("审阅者").ask<string>("审阅改动");
return await hole<Verdict>("评判", `审阅结果：${findings}`);
