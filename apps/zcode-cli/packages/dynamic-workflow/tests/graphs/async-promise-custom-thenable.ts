// Custom thenable: `await thenable` invokes its then() method, which forwards the
// draft's resolved output into the continuation callback -> text.
// Expected: ask#1 -> ask#2 data; ask#2 -> sink.
const draft = agent("writer").ask<string>("draft");
const thenable = {
  then(onOk: (v: string) => void) {
    draft.then(onOk);
  },
};
const text = await thenable;
return agent("editor").ask<string>(`edit: ${text}`);
