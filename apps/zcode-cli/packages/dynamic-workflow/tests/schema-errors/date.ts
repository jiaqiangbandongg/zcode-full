// Date 是宿主对象，不是纯数据 —— 拒绝。
interface WithDate {
  createdAt: Date;
}

const g = agent("g");
const v = await g.ask<WithDate>("go"); // error
log(JSON.stringify(v));
