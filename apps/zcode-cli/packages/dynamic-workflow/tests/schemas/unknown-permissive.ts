// unknown → 许可式空 schema；与具体字段混用时只对 unknown 放行。
interface Payload {
  id: string;
  data: unknown;
  meta: Record<string, unknown>;
}

const g = agent("g");
const payload = await g.ask<Payload>("emit a payload");
const raw = await g.ask<unknown>("emit anything");
log(JSON.stringify(payload) + String(raw));
