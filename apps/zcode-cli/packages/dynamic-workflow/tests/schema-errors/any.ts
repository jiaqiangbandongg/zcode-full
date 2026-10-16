// any 几乎总是失误 —— 拒绝，逼迫改用 unknown 或具体接口。
interface WithAny {
  blob: any;
}

const g = agent("g");
const v = await g.ask<WithAny>("go"); // error
log(JSON.stringify(v));
