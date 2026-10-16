// Map / Set 不可 JSON 序列化 —— 拒绝。两个独立 ask 各报一条。
interface WithMap {
  index: Map<string, number>;
}
interface WithSet {
  seen: Set<string>;
}

const g = agent("g");
const a = await g.ask<WithMap>("map"); // error
const b = await g.ask<WithSet>("set"); // error
log(JSON.stringify(a) + JSON.stringify(b));
