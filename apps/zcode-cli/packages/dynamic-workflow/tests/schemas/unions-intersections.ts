// 一般 union → anyOf（含 null 的对象 union），交叉类型展平为一个 object。
interface Success {
  ok: true;
  value: string;
}
interface Failure {
  ok: false;
  error: string;
}
type Outcome = Success | Failure;

interface HasId {
  id: string;
}
interface HasTimestamp {
  createdAtEpoch: number;
}
type Record_ = HasId & HasTimestamp;

interface Envelope {
  outcome: Outcome;
  maybe: Success | null;
  record: Record_;
}

const g = agent("g");
const envelope = await g.ask<Envelope>("wrap it up");
log(JSON.stringify(envelope));
