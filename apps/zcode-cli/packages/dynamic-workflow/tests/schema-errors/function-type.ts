// 函数类型不可序列化 —— 拒绝（顶层函数类型与对象上的方法成员都算）。
interface WithMethod {
  transform: (input: string) => number;
}

const g = agent("g");
const v = await g.ask<WithMethod>("go"); // error
log(JSON.stringify(v));
