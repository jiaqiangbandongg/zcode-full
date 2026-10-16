// .then callback on a Node<T> result (Node<T> extends PromiseLike<T>). Runtime:
// writer produces a draft; the .then callback runs the editor ask with text =
// draft's resolved output; editor's result becomes `edited` and is returned.
// The keystone rule (unknown calls apply their function arguments) must route
// draft's taint INTO the callback param and the callback's return OUT to the sink.
const draft = agent("writer").ask<string>("write a draft");
const edited = await draft.then((text) => agent("editor").ask<string>(`edit this: ${text}`));
return edited;
