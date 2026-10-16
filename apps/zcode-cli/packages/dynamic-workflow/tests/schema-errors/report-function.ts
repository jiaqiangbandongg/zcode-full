// 函数值不可 JSON 序列化 —— report 在调用点拒绝它。
// 这一条同时是 report 站点定位的证明：诊断落在 report 调用上，而不是落在别处。
const compute = (n: number): number => n * 2;
report(compute); // error
report({ ok: true, count: 2 });
