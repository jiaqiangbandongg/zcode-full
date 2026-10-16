// report(item) 的实参走与 ask<T> 结果同一套可序列化性判定：Date 是宿主对象，不是纯数据。
// 被 report 的 item 与一个 artifact 因为完全相同的理由跨越 journal 与协议边界。
const g = agent("g");
const out = await g.ask<string>("go");
report(new Date(out)); // error
