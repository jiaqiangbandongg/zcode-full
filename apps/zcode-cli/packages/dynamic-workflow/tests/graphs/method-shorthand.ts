// Object-literal shorthand method: `obj.run(s)` must bind s to the method's param
// and route it into the inner worker ask.
const worker = agent("worker");
const s = await agent("s").ask<string>("seed");
const obj = {
  run(x: string): Node<string> {
    return worker.ask<string>(`process ${x}`);
  },
};
const r = await obj.run(s);
return r;
