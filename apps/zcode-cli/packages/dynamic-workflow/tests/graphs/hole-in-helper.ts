// A hole in a helper called twice: one site, two issues (like any helper ask), one phase. The
// hole is awaited inside the helper, so it is not the tail form even though the helper returns it.
interface Verdict {
  pass: boolean;
}
async function judge(topic: string): Promise<Verdict> {
  const findings = await agent(`审阅-${topic}`).ask<string>(`审阅 ${topic}`);
  return await hole<Verdict>("评判", `${topic} 的审阅结果：${findings}`);
}
const front = await judge("前端");
const back = await judge("后端");
return front.pass && back.pass;
