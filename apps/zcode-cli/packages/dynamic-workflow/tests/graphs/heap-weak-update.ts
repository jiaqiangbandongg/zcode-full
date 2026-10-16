// for...of pushing ask results into an outer array (a weak heap update), the array
// then feeding the return. The loop reaches an ask, so it promotes to a fan-out
// node; the element binding carries the fan-out label (additive: it also still
// carries paths' world-read label). Expected:
//   source -> world-read#1, world-read#1 -> fan-out#1   (paths drive the loop)
//   fan-out#1 -> ask#1, world-read#1 -> ask#1           (element into the ask; additive)
//   ask#1 -> sink                                       (only ask results are collected,
//                                                        so fan-out does not reach the sink)
const paths = await files.glob("src/**/*.ts");
const results: string[] = [];
for (const p of paths) {
  const r = await agent("worker").ask<string>(`process ${p}`);
  results.push(r);
}
return results.join("\n");
