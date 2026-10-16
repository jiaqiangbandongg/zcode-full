// 类实例（自定义 class）承载行为，不是纯数据 —— 拒绝。
class Widget {
  constructor(public id: string) {}
  render(): string {
    return this.id;
  }
}

interface Holder {
  widget: Widget;
}

const g = agent("g");
const v = await g.ask<Holder>("go"); // error
log(JSON.stringify(v));
