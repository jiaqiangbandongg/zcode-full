// An object literal captures a live place; mutation THROUGH the literal's field
// must stay visible through the original name.
// Expected: ask#1 -> ask#2 data; ask#2 -> sink.
const box: { f: string } = { f: "" };
const wrap = { inner: box };
wrap.inner.f = await agent("writer").ask<string>("secret");
return agent("reader").ask<string>(`use ${box.f}`);
